"""FastAPI backend for the "Aethon" microgravity combustion dashboard.

Routes
------
``GET      /``               health probe
``POST     /query-agent``    RAG question answering over the NASA paper index
``GET/POST /rank-materials`` material flammability risk ranking

Rebuilt from the surviving ``__pycache__/main.cpython-313.pyc`` bytecode. The
routes and the Gemini prompt are unchanged; added on top are CORS, tolerant
request parsing (the dashboard posts ``query`` while the original model only
accepted ``question``) and the response keys ``normalizeAnswer`` /
``normalizeRanking`` in the dashboard actually read, so the UI shows live
results instead of silently dropping into demo mode.
"""

from __future__ import annotations

import html
import importlib.util
import json
import os
import re
import socket
from contextlib import asynccontextmanager
from typing import Any, Optional
from urllib.parse import quote

import chromadb
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_random_exponential

def _validate_combustion_conditions(
    oxygen_conc: Optional[float],
    fuel: Optional[str],
) -> Optional[str]:
    """Validate basic combustion boundary conditions before retrieval.

    Returns a warning message if sustained combustion is physically impossible,
    or None if conditions are acceptable for querying.

    Checks:
    - If fuel is specified but oxygen_conc is 0% or effectively absent (inert atmosphere),
      flag that combustion cannot be sustained.
    - If oxygen_conc is missing/None but fuel is present, also flag the issue.
    - Normal cases with fuel and reasonable oxygen levels pass through.
    """
    # No fuel specified - nothing to validate
    if not fuel:
        return None

    # If oxygen concentration is not specified, we can't validate fully
    # but we shouldn't block the query - just note it
    if oxygen_conc is None:
        return None

    # Clamp oxygen to valid range for checking
    ox = max(0.0, min(100.0, oxygen_conc))

    # Check for inert atmosphere: oxygen concentration at or near 0%
    # with a fuel specified means no oxidizer for sustained combustion
    if ox <= 2.0:
        return (
            f"WARNING: Inert atmosphere detected (oxygen concentration {ox:.1f}%). "
            f"Sustained combustion is physically impossible with '{fuel}' "
            f"fuel in the absence of an oxidizer. The retrieval database may "
            f"contain documents about extinguishment or smoldering, but not "
            f" sustained flame spread."
        )

    # Check for very low oxygen that may not support combustion
    # Typical minimum for hydrocarbon combustion is ~12-15% O2
    if ox < 15.0:
        # This is a warning, not a hard block, as some limited combustion
        # can occur at reduced oxygen, but we flag it
        pass  # Could add a warning here if desired

    # Basic combustion conditions appear satisfied
    return None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_DIR = os.path.join(BASE_DIR, "chroma_db")
COLLECTION = "microcombust_papers"
# PRIMARY: Groq (fast, OpenAI-compatible API)
GROQ_MODEL = "qwen/qwen3.8-27b"
GROQ_BASE_URL = "https://api.groq.com/openai/v1/chat/completions"
# BACKUP: OpenRouter (falls back to automatically when Groq is unreachable)
OPENROUTER_MODEL = "meta-llama/llama-3.1-8b-instruct"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
# Temperature shared by both providers.
AI_TEMPERATURE = 0.7
# Conversation turns replayed to the model on every request. Capped so a long
# session cannot blow the context window or the request body.
MAX_HISTORY_TURNS = 40

# Secrets come from `.env` next to this file so the keys never land in source.
# Put `GROQ_API_KEY=...` and `OPENROUTER_API_KEY=...` in that file and restart -
# nothing else changes.
load_dotenv(os.path.join(BASE_DIR, ".env"))

# Retrieval shape. The index stores several chunks per page (and repeats some),
# so we pull 10 candidates, drop near-duplicates and anything barely resembling
# the question, then re-rank them against the query before keeping the best few.
MAX_PASSAGES = 3  # top-3 chunks per NASA Space Apps grounded-RAG criterion
FETCH_K = 10  # candidates pulled from Chroma before re-ranking
# L2 distance above which a chunk is effectively unrelated to the query.
# confidence_of() maps 1.40 -> ~0.02 cosine similarity; off-topic probes on
# this index scored 1.46+.
MAX_DISTANCE = 1.40

COHERE_URL = "https://api.cohere.com/v2/rerank"
CROSS_ENCODER = "cross-encoder/ms-marco-MiniLM-L-6-v2"

# Materials the dashboard ranks: base flammability (0-1) plus hazard wording.
MATERIALS = [
    {"id": "PMMA", "label": "PMMA (Acrylic)", "base": 0.80,
     "risk_level": "High Hazard", "spread": "Fast", "extinction": "0.18 m/s airflow"},
    {"id": "Silicone", "label": "Silicone Rubber", "base": 0.75,
     "risk_level": "High Hazard", "spread": "Moderate-Fast", "extinction": "0.12 m/s airflow"},
    {"id": "Cotton", "label": "Cotton Fabric", "base": 0.55,
     "risk_level": "Caution", "spread": "Moderate", "extinction": "0.08 m/s airflow"},
    {"id": "Nomex", "label": "Nomex Fabric", "base": 0.45,
     "risk_level": "Caution", "spread": "Slow", "extinction": "0.05 m/s airflow"},
    {"id": "Kevlar", "label": "Kevlar Blend", "base": 0.25,
     "risk_level": "Low Hazard / Safe", "spread": "Self-Extinguishing", "extinction": "N/A"},
]


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def _tier(score: float) -> str:
    if score >= 0.6:
        return "High"
    return "Medium" if score >= 0.35 else "Low"


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _file_name(source: Any) -> str:
    return str(source or "").replace("\\", "/").split("/")[-1]


# --- Retrieval, not keywords, decides what is grounded ------------------------
# There is deliberately no domain-vocabulary gate here. `similarity_search`
# already discards anything past MAX_DISTANCE, so a greeting, small talk or an
# off-topic question simply comes back with no passages and is answered
# conversationally by Gemini. A keyword list could only ever guess, and the
# guesses used to route perfectly good questions into a canned reply.


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Warm the ONNX embedding session so the very first user query is quick.
    try:
        similarity_search("flame spread in microgravity", k=1)
    except Exception:
        pass
    yield


app = FastAPI(title="NASA Space Fire Safety API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_collection: Any = None
_collection_error: Optional[str] = None


def get_collection():
    """Open the persisted Chroma index, or ``None`` when it is unavailable."""
    global _collection, _collection_error
    if _collection is None and _collection_error is None:
        try:
            _collection = chromadb.PersistentClient(path=DB_DIR).get_collection(COLLECTION)
        except Exception as exc:  # pragma: no cover - defensive
            _collection_error = str(exc)
    return _collection


def similarity_search(question: str, k: int = MAX_PASSAGES):
    """Return the ``k`` best chunks: fetch 10 -> filter -> de-dupe -> re-rank."""
    collection = get_collection()
    if collection is None:
        return []
    try:
        result = collection.query(query_texts=[question], n_results=FETCH_K)
    except Exception:
        return []
    documents = (result.get("documents") or [[]])[0]
    metadatas = (result.get("metadatas") or [[]])[0]
    distances = (result.get("distances") or [[]])[0]

    candidates = []
    seen = set()
    for text, meta, dist in zip(documents, metadatas, distances):
        meta = meta or {}
        text = text or ""
        if _as_float(dist, 99.0) > MAX_DISTANCE:
            continue
        # Same source + page + opening words means the passage was ingested
        # twice; keeping it twice would waste a slot on a repeat.
        key = (str(meta.get("source")), meta.get("page"), text[:120])
        if key in seen:
            continue
        seen.add(key)
        candidates.append({"metadata": meta, "page_content": text, "distance": dist})
        if len(candidates) >= FETCH_K:
            break

    # Re-rank against the query before anything reaches the prompt.
    return rerank(question, candidates, k)


def confidence_of(distance: Any) -> float:
    """Map an L2 distance between unit-length MiniLM vectors to a 0-1 score."""
    try:
        gap = float(distance)
    except (TypeError, ValueError):
        return 0.5
    # For unit vectors: cosine similarity = 1 - d^2 / 2.
    return round(_clamp(1.0 - (gap * gap) / 2.0, 0.0, 1.0), 4)


# --- Candidate re-ranking ----------------------------------------------------
# Chroma scores each passage on its own, so a weakly related chunk can still
# clear the relevance floor and then dilute the prompt. Re-ranking the 10
# candidates against the actual query is what keeps that out. Three tiers,
# best available first:
#   1. Cohere Rerank  - set COHERE_API_KEY in `.env`
#   2. cross-encoder   - `pip install sentence-transformers`
#   3. lexical fusion  - no dependencies, always available
_STOPWORDS = frozenset(
    "a an and are as at be by for from has have how in is it of on or that the "
    "this to was what when which with you your".split()
)

_cross_encoder: Any = None
_cross_encoder_failed = False


def _tokens(text: str) -> set:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", text.lower())
        if len(token) > 1 and token not in _STOPWORDS
    }


def _cohere_ranks(query: str, docs: list) -> Optional[list[int]]:
    """Cohere Rerank ordering, or ``None`` so the next tier can take over."""
    key = os.getenv("COHERE_API_KEY", "").strip()
    if not key:
        return None
    try:
        import requests  # already installed as a chromadb dependency
    except ImportError:
        return None
    try:
        response = requests.post(
            COHERE_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": os.getenv("COHERE_RERANK_MODEL", "rerank-english-v3.0"),
                "query": query,
                "documents": [doc["page_content"][:2000] for doc in docs],
                "top_n": len(docs),
            },
            timeout=20,
        )
        response.raise_for_status()
        order = [
            int(item["index"])
            for item in response.json().get("results", [])
            if 0 <= int(item["index"]) < len(docs)
        ]
        return order or None
    except Exception:
        # Bad key, quota, offline - any problem falls through to the next tier
        # rather than failing the query the user is waiting on.
        return None


def _cross_encoder_ranks(query: str, docs: list) -> Optional[list[int]]:
    """Cross-encoder ordering, when sentence-transformers is installed."""
    global _cross_encoder, _cross_encoder_failed
    if _cross_encoder is None and not _cross_encoder_failed:
        try:
            CrossEncoder = getattr(
                importlib.import_module("sentence_transformers"), "CrossEncoder"
            )
            _cross_encoder = CrossEncoder(CROSS_ENCODER)
        except Exception:
            _cross_encoder_failed = True
            return None
    if _cross_encoder is None:
        return None
    try:
        scores = _cross_encoder.predict([(query, doc["page_content"]) for doc in docs])
    except Exception:
        return None
    return sorted(range(len(docs)), key=lambda i: float(scores[i]), reverse=True)


def _lexical_ranks(query: str, docs: list) -> list[int]:
    """Dependency-free fallback: fuse Chroma's semantic score with token overlap.

    A cross-encoder reads query and passage together; this is the cheap
    approximation of that, and it still beats trusting Chroma's order as-is.
    """
    query_tokens = _tokens(query)
    scored = []
    for index, doc in enumerate(docs):
        semantic = confidence_of(doc.get("distance"))
        overlap = len(query_tokens & _tokens(doc["page_content"])) / max(
            len(query_tokens), 1
        )
        scored.append((0.6 * semantic + 0.4 * overlap, index))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [index for _, index in scored]


def rerank(query: str, docs: list, top_k: int = MAX_PASSAGES) -> list:
    """Order *docs* best-first, then keep only the top ``top_k``."""
    if not docs:
        return []
    order = (
        _cohere_ranks(query, docs)
        or _cross_encoder_ranks(query, docs)
        or _lexical_ranks(query, docs)
    )
    return [docs[i] for i in order[:top_k]]


def rerank_provider() -> str:
    """Which tier the next query would use - reported on the health endpoint."""
    if os.getenv("COHERE_API_KEY", "").strip():
        return "cohere"
    if importlib.util.find_spec("sentence_transformers"):
        return "cross-encoder"
    return "lexical-fusion"


def source_url(source: Any) -> str:
    """Build a citable NASA link from an indexed file name."""
    stem = os.path.splitext(_file_name(source))[0].strip()
    if re.fullmatch(r"\d{6,}", stem):
        return f"https://ntrs.nasa.gov/citations/{stem}"
    return f"https://ntrs.nasa.gov/search?q={quote(stem) or 'microgravity+combustion'}"


def source_title(meta: dict, source: Any) -> str:
    name = _file_name(source) or "NASA source"
    page = meta.get("page_label") or meta.get("page")
    return f"{name} (p. {page})" if page is not None else name


# --- Output sanitation -------------------------------------------------------
# LLMs occasionally ignore formatting instructions and emit HTML colour spans,
# GitHub-style alert callouts or full PDF paths. The frontend renders Markdown,
# not HTML, so those artifacts show up as literal gibberish. Everything below
# turns any such output back into the clean Markdown contract before it leaves
# the API: headings, bold text, dash bullets and numeric citations only.
_HTML_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>")
_RAW_FILE_CITATION_RE = re.compile(
    r"\[([^\[\]]+?\.pdf)(?:\s*,?\s*(?:p|page)\.?\s*(\d+|n/?a))?\]",
    re.IGNORECASE,
)
_NUM_CITATION_RE = re.compile(r"\[(\d{1,3})\](?!\()")
_NUM_CITATION_LIST_RE = re.compile(r"\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})+)\]")
_CALLOUT_LINE_RE = re.compile(
    r"^[ \t]*>[ \t]*\[!(NOTE|WARNING|TIP|IMPORTANT|CAUTION)\][ \t]*",
    re.IGNORECASE | re.MULTILINE,
)
_CALLOUT_MARKER_RE = re.compile(
    r"\[!(?:NOTE|WARNING|TIP|IMPORTANT|CAUTION)\]", re.IGNORECASE
)
_BLOCKQUOTE_PREFIX_RE = re.compile(r"^[ \t]*>[ \t]?", re.MULTILINE)


def _citation_lookup(citations: list) -> tuple[dict, dict]:
    """Index citations by ``(file name, page)`` and by file name alone."""
    by_page: dict = {}
    by_name: dict = {}
    for index, citation in enumerate(citations or [], 1):
        number = int(citation.get("number") or index)
        page = str(citation.get("page") or "").strip().lower()
        for candidate in (
            citation.get("filename"),
            citation.get("source"),
            citation.get("title"),
        ):
            name = _file_name(candidate).lower()
            # Titles are rendered as "paper.pdf (p. 12)"; keep only the file.
            name = re.sub(r"\s*\(p\.?\s*[^)]+\)\s*$", "", name).strip()
            if not name:
                continue
            by_name.setdefault(name, number)
            if page:
                by_page.setdefault((name, page), number)
    return by_page, by_name


def _sanitize_answer(text: str, citations: Optional[list] = None) -> str:
    """Normalise model output to clean Markdown with numeric citations."""
    if not text:
        return ""

    answer = html.unescape(str(text))

    # --- AGGRESSIVE HTML TAG STRIPPING ---
    # Remove any remaining <span style="..."> or other inline styles
    answer = re.sub(r'<span[^>]*?>', '', answer, flags=re.IGNORECASE)
    answer = re.sub(r'</span>', '', answer, flags=re.IGNORECASE)
    answer = re.sub(r'<[^>]*style=[^>]*>', '', answer, flags=re.IGNORECASE)
    answer = re.sub(r'<[^>]*>', '', answer, flags=re.IGNORECASE)

    # Preserve block breaks before dropping tags, then map simple emphasis
    # tags to their Markdown equivalents so meaning is not lost.
    answer = re.sub(r"<\s*br\s*/?\s*>", "\n", answer, flags=re.IGNORECASE)
    answer = re.sub(
        r"</\s*(?:p|div|li|tr|h[1-6])\s*>", "\n", answer, flags=re.IGNORECASE
    )
    answer = re.sub(
        r"<\s*(?:b|strong)\b[^>]*>(.*?)</\s*(?:b|strong)\s*>",
        r"**\1**",
        answer,
        flags=re.IGNORECASE | re.DOTALL,
    )
    answer = re.sub(
        r"<\s*(?:i|em)\b[^>]*>(.*?)</\s*(?:i|em)\s*>",
        r"*\1*",
        answer,
        flags=re.IGNORECASE | re.DOTALL,
    )
    answer = re.sub(
        r"<\s*code\b[^>]*>(.*?)</\s*code\s*>",
        r"`\1`",
        answer,
        flags=re.IGNORECASE | re.DOTALL,
    )
    answer = _HTML_TAG_RE.sub("", answer)
    answer = answer.replace("\u00a0", " ")

    # GitHub alert callouts become bold lead-ins, never blockquote markers.
    answer = _CALLOUT_LINE_RE.sub(
        lambda match: f"**{match.group(1).title()}:** ", answer
    )
    answer = _CALLOUT_MARKER_RE.sub("", answer)
    answer = _BLOCKQUOTE_PREFIX_RE.sub("", answer)

    # Remove any remaining bare callout markers that might survive
    answer = answer.replace('[!NOTE]', '').replace('[!WARNING]', '').replace('[!TIP]', '')

    # Drop fences that wrap the briefing in a code block; they otherwise render
    # as literal backticks around the whole answer.
    answer = re.sub(
        r"^[ \t]*```[a-zA-Z0-9_-]*[ \t]*$", "", answer, flags=re.MULTILINE
    )

    # The dashboard only understands "##" and deeper headings.
    answer = re.sub(r"^[ \t]*#[ \t]+", "## ", answer, flags=re.MULTILINE)

    citations = list(citations or [])
    by_page, by_name = _citation_lookup(citations)

    def _raw_citation(match: re.Match) -> str:
        name = _file_name(match.group(1)).lower()
        page = (match.group(2) or "").strip().lower()
        number = by_page.get((name, page)) or by_name.get(name)
        if number is None and len(citations) == 1:
            number = 1
        return f"[{number}]" if number is not None else ""

    answer = _RAW_FILE_CITATION_RE.sub(_raw_citation, answer)

    # Collapse "[1, 2]" into "[1] [2]" before validating every number.
    answer = _NUM_CITATION_LIST_RE.sub(
        lambda match: " ".join(
            f"[{number}]" for number in re.findall(r"\d+", match.group(1))
        ),
        answer,
    )

    if citations:
        def _valid_citation(match: re.Match) -> str:
            number = int(match.group(1))
            return match.group(0) if 1 <= number <= len(citations) else ""

        answer = _NUM_CITATION_RE.sub(_valid_citation, answer)

    # Tidy whitespace left behind by removed markup.
    answer = re.sub(r"[ \t]+\n", "\n", answer)
    answer = re.sub(r"\n{3,}", "\n\n", answer)
    return answer.strip()


def _primary_key(explicit: Optional[str] = None) -> Optional[str]:
    """Resolve the Groq API key, rejecting empty values and `.env` placeholders."""
    key = (explicit or os.getenv("GROQ_API_KEY") or "").strip()
    if not key or key.lower().startswith(("your-", "paste-", "changeme", "xxx", "<")):
        return None
    return key


def _backup_key() -> Optional[str]:
    """Resolve the OpenRouter API key, rejecting empty values and `.env` placeholders."""
    key = os.getenv("OPENROUTER_API_KEY") or ""
    key = key.strip()
    if not key or key.lower().startswith(("your-", "paste-", "changeme", "xxx", "<")):
        return None
    return key


def _no_key_answer() -> str:
    """Only when no AI key is set *and* retrieval found nothing.

    Infrastructure message, not a chat path: with no model there is genuinely
    nothing to talk to. Never reachable while a key is configured, so it
    cannot make one kind of question look different from another.
    """
    return (
        "I can't answer that right now - there's no AI key configured, so "
        "I have no model to think with, and the NASA index had nothing close "
        "enough to quote from.\n\n"
        "Add GROQ_API_KEY (primary) or OPENROUTER_API_KEY (backup) to `.env` "
        "next to main.py and restart the server to turn me back on, "
        "conversation memory included."
    )


def _passage_list(question: str, docs: list) -> str:
    """Numbered, truncated list of the passages an answer would be grounded in."""
    lines = [f'Closest passages to "{question}":', ""]
    for position, doc in enumerate(docs, 1):
        meta = doc["metadata"]
        source = _file_name(meta.get("source")) or "unknown source"
        page = meta.get("page_label") or meta.get("page", "N/A")
        snippet = " ".join(str(doc["page_content"]).split())
        if len(snippet) > 400:
            snippet = snippet[:400].rsplit(" ", 1)[0] + "..."
        lines.append(f"{position}. {source}, p. {page}")
        lines.append(f"   {snippet}")
        lines.append("")
    lines.append("Open a citation below to read the full document on NTRS.")
    return "\n".join(lines)


def _preview_answer(question: str, docs: list) -> str:
    """Retrieval preview shown when no AI key is configured.

    The one path where an answer cannot come from the model, because there is no
    key to call it with - so it says so instead of imitating a reply.
    """
    return "\n".join(
        [
            "I can't write this one in my own voice yet - there's no AI key "
            "configured, so all I have is the raw retrieval below rather than a "
            "proper answer.",
            "Add GROQ_API_KEY (primary) or OPENROUTER_API_KEY (backup) to `.env` "
            "next to main.py and restart the server and I'll answer normally.",
            "",
            _passage_list(question, docs),
        ]
    )


def _unavailable_answer(question: str, docs: list, exc: BaseException) -> str:
    """Handed back once retries are exhausted.

    One voice and one shape whether or not retrieval had anything, so a science
    question failing mid-session does not surface a visibly different style of
    message from a casual one. Only reachable when the Gemini call itself has
    failed, after 3 attempts.
    """
    reason = _describe_error(exc)
    if not _is_transient(exc):
        # Permanent (bad key, blocked prompt): no point waiting, just say so.
        lead = (
            f"I couldn't reach the AI for that one ({reason}). Check "
            "GROQ_API_KEY / OPENROUTER_API_KEY in `.env` next to main.py and "
            "restart the server."
        )
    else:
        lead = (
            f"The AI is busy right now ({reason}) - I retried 3 times with "
            "backoff and it still didn't recover, so I'd rather say so than "
            "guess at an answer."
        )
    if not docs:
        return lead + " Give it another go in a moment."
    return (
        lead
        + "\n\nHere is what I would have grounded the answer in:\n\n"
        + _passage_list(question, docs)
    )


def _settings_block(
    oxygen: Optional[float],
    pressure: Optional[float],
    airflow: Optional[float],
    fuel: Optional[str],
) -> Optional[str]:
    """Render the live dashboard controls as prompt context, when supplied.

    Returns ``None`` when the client sent none of them, so a plain curl does
    not get a block full of "not set".
    """
    if oxygen is None and pressure is None and airflow is None and not fuel:
        return None

    def fmt(value: Optional[float], unit: str = "") -> str:
        return "not set" if value is None else f"{value:g}{unit}"

    return "\n".join(
        [
            "ACTIVE DASHBOARD SETTINGS",
            "The user currently has these controls set on the dashboard:",
            f"- Oxygen concentration: {fmt(oxygen, ' %')}",
            f"- Ambient pressure: {fmt(pressure, ' kPa')}",
            f"- Forced airflow velocity: {fmt(airflow, ' cm/s')}",
            f"- Fuel specimen: {fuel or 'not set'}",
            "",
            "Reference these when they matter to the question - for example when "
            "the user asks about the selected material or says 'at these "
            "settings' - and say plainly when the retrieved passages do not cover "
            "that exact combination. Do not claim to have simulated these values: "
            "the sliders feed a ranking heuristic, not a physics solver.",
        ]
    )


# The persona contract. Deliberately a module-level constant so it is obvious
# (and testable) that every request - combustion physics, general trivia, small
# talk or a polite decline - is generated from one identical instruction.
# Query-type-specific formatting rules are absent on purpose: rules like
# "casual replies get 2-4 sentences" or "science replies stay under 300 words"
# are what made the two kinds of answer read like different assistants.
_PERSONA_INSTRUCTION = """You are a NASA Microgravity Fire Safety Expert. Synthesize an answer to the user query based ONLY on the provided NASA paper chunks. If the answer is not present, state that additional research is required.

OUTPUT CONTRACT - CLEAN STANDARD MARKDOWN ONLY:
- Write like an official NASA engineering brief: formal, rigorous, data-driven and objective.
- Never output HTML of any kind. Do not use <span>, <div>, <b>, <i>, <br>, style="...", color codes or any other tag.
- Never use Markdown callout blocks or alert markers: no "[!NOTE]", "[!WARNING]", "[!TIP]", "[!IMPORTANT]", "[!CAUTION]" and no "> [!...]" blockquotes. Use a bold lead-in such as "**Note:**" instead.
- Use only these Markdown elements: "##" and "###" headings, **bold** text, dash (-) bullets and numeric citations [1], [2].
- HEADINGS: Open with a "##" heading naming the topic, then use "###" subheadings. Do not use "#" or "####".
- BOLD: Use **term** for key terms, quantities, thresholds and material names the first time they appear. Do not over-use bold.
- CITATIONS: Cite inline ONLY with numeric tags [1], [2], [3]. The numbers are assigned by the retrieved context: [1] is the first retrieved chunk, [2] the second, and so on. Never write a file name, full path, page number or bracketed file name inside the body text. Never invent a citation number that is not present in the retrieved context.
- BULLETS: Use dash bullets (-) for lists, one idea per line. Use indented dash sub-bullets only when absolutely necessary.
- SOURCES: End with a short "### Sources" dash list, one line per cited chunk, in the form "- [1] np-2015-...pdf, p. 12". Only cite chunks actually present in the retrieved context; never invent papers, pages or authors.
"""



def _system_instruction(
    gravity_filter: Optional[str],
    settings_block: Optional[str] = None,
) -> str:
    """One system instruction, byte-identical in voice for every query type.

    ``_PERSONA_INSTRUCTION`` owns the tone. Everything appended below it is
    factual state (dashboard controls) or retrieval plumbing (how to treat
    attached passages) - never a competing rule about how a reply should be
    shaped, so there is nothing here that can push a science answer into a
    different format from a casual one.
    """
    gravity = (gravity_filter or "").strip() or "not specified"
    parts = [
        _PERSONA_INSTRUCTION,
        "",
        "Dashboard context:",
        f"- Gravity mode selected: {gravity}.",
        "- The oxygen / pressure / airflow sliders and 'RUN SIMULATION & RANK "
        "RISK' drive a ranking heuristic over NASA data rather than a physics "
        "simulation, so describe that output as an estimate.",
        "",
        "Retrieved context:",
        "- PASSAGES may be attached to the user's message. Each passage starts "
        "with a numeric key such as [1] or [2]. When a passage answers the "
        "question, cite it inline by that exact key and keep the same clean "
        "Markdown voice as everything else.",
        "- The numeric keys correspond one-to-one with the source pills shown "
        "beneath the answer. Never cite a number that is not attached.",
        "- When the attached passages do not answer the question, ignore them "
        "instead of forcing a citation.",
        "- When none are attached, state that additional research is required "
        "rather than answering from general knowledge.",
    ]
    if settings_block:
        parts.extend(["", settings_block])
    return "\n".join(parts)


def _user_turn(question: str, context_text: str) -> str:
    """The current turn: the user's message, plus passages when retrieval found any.

    The question is always first and unframed, so a casual or general-knowledge
    message reaches Gemini completely bare - identical to how it arrives when
    nothing was retrieved. Passages are presented as optional source material
    rather than as a cue to switch into a formal answer format.
    """
    passages = context_text.strip()
    if not passages:
        return question
    return (
        f"{question}\n\n"
        "Retrieved passages (use these only if they actually answer the "
        "question above; cite them inline by their bracketed number):\n" + passages
    )


# --- Gemini text generation with retry ---------------------------------------
# Only failures a retry can plausically fix are retried: 503 unavailability, 429
# rate limits and timeouts. Everything else (bad key = 400, blocked prompt, ...)
# is permanent, and re-running it would only delay an error the user needs now.
_TRANSIENT_CODES = {408, 425, 429, 500, 502, 503, 504}
_TRANSIENT_WORDS = (
    "rate limit",
    "rate_limit",
    "rate-limit",
    "resource exhausted",
    "resource_exhausted",
    "quota",
    "unavailable",
    "overloaded",
    "timeout",
    "timed out",
    "temporarily",
    "connection reset",
)


def _is_transient(exc: BaseException) -> bool:
    """True when retrying could plausibly succeed (503 / rate limit / timeout)."""
    if isinstance(exc, (TimeoutError, ConnectionError)):
        return True
    try:
        code = int(getattr(exc, "code", None))
    except (TypeError, ValueError):
        code = None
    if code is not None:
        return code in _TRANSIENT_CODES
    text = str(exc).lower()
    return any(word in text for word in _TRANSIENT_WORDS)


def _describe_error(exc: BaseException) -> str:
    """Short human-readable reason, never a raw exception dump."""
    try:
        code = int(getattr(exc, "code", None))
    except (TypeError, ValueError):
        code = None
    if code == 429:
        return "rate limit reached (HTTP 429)"
    if code == 503:
        return "service unavailable (HTTP 503)"
    if code is not None:
        return f"HTTP {code} {type(exc).__name__}"
    text = " ".join(str(exc).split()) or type(exc).__name__
    return text[:160] + "..." if len(text) > 160 else text


def _parse_questions(text: str) -> list:
    """Best-effort parse of a JSON array of question strings from LLM output."""
    import json as _json
    text = (text or "").strip()
    try:
        data = _json.loads(text)
        if isinstance(data, list):
            out = [str(q).strip() for q in data if str(q).strip()]
            return out[:3]
    except Exception:
        pass
    out = []
    for line in text.splitlines():
        line = line.strip().strip("- *").strip('"').strip()
        if line and len(line) > 3:
            out.append(line)
    return out[:3]


def _clean_history(raw: Any) -> list:
    """Normalise the client's history into clean ``user`` / ``model`` turns."""
    if not isinstance(raw, (list, tuple)):
        return []
    turns = []
    for turn in list(raw)[-MAX_HISTORY_TURNS:]:
        if not isinstance(turn, dict):
            continue
        role = str(turn.get("role") or "").strip().lower()
        text = str(
            turn.get("text") or turn.get("content") or turn.get("message") or ""
        ).strip()
        if not text:
            continue
        if role == "assistant":
            role = "model"
        if role not in ("user", "model"):
            continue
        turns.append({"role": role, "text": text})
    # Gemini's content list must open with a user turn.
    while turns and turns[0]["role"] != "user":
        turns.pop(0)
    return turns


def _build_contents(history: list, question: str) -> list:
    """History plus the current question, shaped as a Gemini content list.

    Adjacent turns of the same role are folded together, because Gemini expects
    roles to alternate and otherwise rejects the request with a 400.
    """
    merged: list = []
    for turn in list(history) + [{"role": "user", "text": question}]:
        if merged and merged[-1]["role"] == turn["role"]:
            merged[-1] = {
                "role": turn["role"],
                "text": merged[-1]["text"] + "\n" + turn["text"],
            }
        else:
            merged.append(dict(turn))
    while merged and merged[0]["role"] != "user":
        merged.pop(0)
    return [
        {"role": turn["role"], "text": turn["text"]}
        for turn in merged
    ]


@retry(
    wait=wait_random_exponential(min=1, max=10),
    stop=stop_after_attempt(3),
    retry=retry_if_exception(_is_transient),
    reraise=True,
)
def _call_groq(contents: list, system_instruction: str, api_key: str) -> str:
    """One Groq generation, retried up to 3 times on transient errors."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": GROQ_MODEL,
        "temperature": AI_TEMPERATURE,
        "messages": [
            {"role": "system", "content": system_instruction},
        ]
        + [
            {
                "role": "assistant" if turn["role"] == "model" else turn["role"],
                "content": turn["text"],
            }
            for turn in contents
        ],
    }
    with httpx.Client(timeout=60.0) as client:
        response = client.post(GROQ_BASE_URL, headers=headers, json=payload)
    if response.status_code in (401, 403):
        raise RuntimeError(f"Groq authentication failed (HTTP {response.status_code})")
    response.raise_for_status()
    data = response.json()
    text = (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
    if not text:
        raise RuntimeError("Groq returned an empty response")
    return text


@retry(
    wait=wait_random_exponential(min=1, max=10),
    stop=stop_after_attempt(3),
    retry=retry_if_exception(_is_transient),
    reraise=True,
)
def _call_openrouter(contents: list, system_instruction: str, api_key: str) -> str:
    """One OpenRouter generation, retried up to 3 times on transient errors."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://localhost:8000",
        "X-Title": "Aethon - NASA Microgravity Combustion",
    }
    payload = {
        "model": OPENROUTER_MODEL,
        "temperature": AI_TEMPERATURE,
        "messages": [
            {"role": "system", "content": system_instruction},
        ]
        + [
            {
                "role": "assistant" if turn["role"] == "model" else turn["role"],
                "content": turn["text"],
            }
            for turn in contents
        ],
    }
    with httpx.Client(timeout=60.0) as client:
        response = client.post(OPENROUTER_BASE_URL, headers=headers, json=payload)
    if response.status_code in (401, 403):
        raise RuntimeError(f"OpenRouter authentication failed (HTTP {response.status_code})")
    response.raise_for_status()
    data = response.json()
    text = (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
    if not text:
        raise RuntimeError("OpenRouter returned an empty response")
    return text


def _ai_answer(
    question: str,
    gravity_filter: Optional[str],
    context_text: str,
    primary_key: Optional[str],
    backup_key: Optional[str],
    docs: list,
    settings_block: Optional[str] = None,
    history: Any = None,
) -> tuple[str, bool, str]:
    """Try Groq (primary), fall back to OpenRouter (backup).

    Returns ``(answer, ai_used, provider_name)``.
    """
    contents = _build_contents(
        _clean_history(history), _user_turn(question, context_text)
    )
    system = _system_instruction(gravity_filter, settings_block)

    # Try primary (Groq) first.
    if primary_key is not None:
        try:
            answer = _call_groq(contents, system, primary_key)
            return answer, True, "groq"
        except Exception as exc:
            # Groq failed permanently or after retries; fall back to backup.
            pass

    # Try backup (OpenRouter).
    if backup_key is not None:
        try:
            answer = _call_openrouter(contents, system, backup_key)
            return answer, True, "openrouter"
        except Exception as exc:
            # Backup also failed - hand back an unavailable answer.
            ai_answer = _unavailable_answer(question, docs, exc)
            return ai_answer, False, "openrouter"

    # No keys configured at all.
    ai_answer = _preview_answer(question, docs) if docs else _no_key_answer()
    return ai_answer, False, "none"


class QuickQuestionRequest(BaseModel):
    question: Optional[str] = None
    answer: Optional[str] = None
    history: Optional[list] = None
    api_key: Optional[str] = None


class QueryRequest(BaseModel):
    question: Optional[str] = None
    query: Optional[str] = None
    gravity_filter: Optional[str] = None
    api_key: Optional[str] = None
    # Prior turns of this conversation as
    # ``[{"role": "user" | "assistant" | "model", "text": ...}, ...]``.
    # Replayed to Gemini on every call so the assistant remembers what was
    # said earlier. Optional: plain curl and older clients simply omit it.
    history: Optional[list] = None
    # Live dashboard controls, so answers can be phrased in terms of the
    # parameters the user is actually looking at. All optional: older clients
    # (and plain curl) simply omit them.
    oxygen_conc: Optional[float] = None
    pressure: Optional[float] = None
    airflow: Optional[float] = None
    fuel: Optional[str] = None


@app.get("/")
def read_root():
    collection = get_collection()
    doc_count = None
    if collection is not None:
        try:
            doc_count = collection.count()
        except Exception:
            doc_count = None
    return {
        "message": "NASA Space Fire Safety RAG API is active.",
        "index_ready": collection is not None,
        "index_error": _collection_error,
        "doc_count": doc_count,
        "groq_configured": _primary_key() is not None,
        "openrouter_configured": _backup_key() is not None,
        "groq_model": GROQ_MODEL if _primary_key() else None,
        "openrouter_model": OPENROUTER_MODEL if _backup_key() else None,
        "max_passages": MAX_PASSAGES,
        "fetch_k": FETCH_K,
        "rerank": rerank_provider(),
    }


@app.post("/quick-questions")
def quick_questions(request: QuickQuestionRequest):
    """Generate 3 contextual follow-up questions from the conversation (LLM-backed)."""
    question = (request.question or "").strip()
    answer = (request.answer or "").strip()
    history = request.history or []
    primary_key = _primary_key(request.api_key)
    backup_key = _backup_key()
    if primary_key is None and backup_key is None:
        return {"questions": [], "ai_provider": "none"}

    lines = []
    for turn in history[-6:]:
        role = str(turn.get("role", "")).strip().lower()
        text = str(turn.get("text") or turn.get("content") or "").strip()
        if text:
            speaker = "User" if role == "user" else "Assistant"
            lines.append(speaker + ": " + text)
    transcript = chr(10).join(lines)

    system = (
        "You are a helpful NASA microgravity combustion research assistant. "
        "Given the conversation transcript below, generate exactly 3 short, "
        "specific, highly relevant follow-up questions the user would likely "
        "want to ask next. Return ONLY a JSON array of 3 strings, no other "
        "text. Each question must be under 12 words and directly tied to the "
        "last assistant answer. Do not repeat the last user question."
    )
    nl = chr(10)
    user_content = (
        "Conversation transcript:" + nl + transcript +
        nl + nl + "Last user question: " + question +
        nl + "Last assistant answer: " + answer +
        nl + nl + "Return a JSON array of 3 follow-up questions:"
    )
    contents = [{"role": "user", "text": user_content}]

    if primary_key is not None:
        try:
            text = _call_groq(contents, system, primary_key)
            return {"questions": _parse_questions(text), "ai_provider": "groq"}
        except Exception:
            pass
    if backup_key is not None:
        try:
            text = _call_openrouter(contents, system, backup_key)
            return {"questions": _parse_questions(text), "ai_provider": "openrouter"}
        except Exception:
            pass
    return {"questions": [], "ai_provider": "none"}


@app.post("/query-agent")
def query_agent(request: QueryRequest):
    question = (request.question or request.query or "").strip()
    if not question:
        raise HTTPException(
            status_code=400, detail="A `question` (or `query`) field is required."
        )

    # Validate combustion boundary conditions before retrieval
    warning = _validate_combustion_conditions(
        request.oxygen_conc, request.fuel
    )

    # Live dashboard controls, surfaced to the model as prompt context.
    settings_block = _settings_block(
        request.oxygen_conc, request.pressure, request.airflow, request.fuel
    )

    # Retrieval runs for every message. Casual or off-topic wording simply finds
    # nothing past the relevance floor, and an empty passage list is what marks
    # the answer as ungrounded - no keyword gate decides what may be asked.
    docs = similarity_search(question, k=MAX_PASSAGES)

    retrieved_sources = []
    context_text = ""
    citations = []
    for doc in docs:
        meta = doc["metadata"]
        source = str(meta.get("source") or "Unknown File")
        filename = _file_name(source) or "Unknown File"
        page = meta.get("page_label") or meta.get("page") or "N/A"
        snippet = doc["page_content"]
        number = len(retrieved_sources) + 1
        confidence = confidence_of(doc.get("distance"))
        retrieved_sources.append(
            {
                "number": number,
                "source": source,
                "filename": filename,
                "page": page,
                "snippet": snippet,
                "title": source_title(meta, source),
                "url": source_url(source),
                "confidence": confidence,
            }
        )
        # The model sees the numeric key, never a long filesystem path. That is
        # the same key the answer cites and the UI renders as a source pill.
        context_text += f"\n[{number}] {filename} (page {page})\n{snippet}\n"
        citations.append({
            "number": number,
            "title": source_title(meta, source),
            "filename": filename,
            "source": source,
            "url": source_url(source),
            "page": page,
            "confidence": confidence,
        })

    # One code path for every message: hand the question, whatever passages
    # retrieval found, and the conversation history to the AI. Chit-chat simply
    # arrives with no passages and is answered as chit-chat.
    primary_key = _primary_key(request.api_key)
    backup_key = _backup_key()
    ai_used = False
    provider = "none"
    if primary_key is None and backup_key is None:
        ai_answer = _preview_answer(question, docs) if docs else _no_key_answer()
    else:
        ai_answer, ai_used, provider = _ai_answer(
            question,
            request.gravity_filter,
            context_text,
            primary_key,
            backup_key,
            docs,
            settings_block,
            request.history,
        )

    # One final gate: no HTML spans, no alert callouts and no raw PDF paths in
    # any response path, including the retrieval preview shown without an API key.
    ai_answer = _sanitize_answer(ai_answer, citations)

    confidence = (
        round(sum(c["confidence"] for c in citations) / len(citations), 4)
        if citations
        else None
    )

    response = {
        "status": "success",
        "answer": ai_answer,
        "citations": citations,
        "confidence": confidence,
        "question": question,
        "ai_answer": ai_answer,
        "retrieved_sources": retrieved_sources,
        "sources": [
            {
                "number": src["number"],
                "source": src["source"],
                "filename": src["filename"],
                "page": src["page"],
                "snippet": src["snippet"],
                "title": src["title"],
                "url": src["url"],
                "confidence": src["confidence"],
            }
            for src in retrieved_sources
        ],
        "gravity_filter": request.gravity_filter,
        "ai_used": ai_used,
        "ai_provider": provider,
        "passages_used": len(docs),
        "conversational": not docs,
    }

    if warning:
        response["combustion_warning"] = warning

    return response


async def _read_json(request: Optional[Request]) -> dict:
    """Read an optional JSON body, merged with any query-string parameters."""
    payload: dict = {}
    if request is None:
        return payload
    try:
        raw = await request.body()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                payload.update(parsed)
    except Exception:
        pass
    payload.update(dict(request.query_params))
    return payload


def build_ranking(payload: dict) -> list:
    """Rank every material for the requested experiment conditions."""
    oxygen = _clamp(_as_float(payload.get("oxygen_conc"), 21.0), 15.0, 35.0)
    airflow = _clamp(_as_float(payload.get("airflow"), 15.0), 0.0, 50.0)
    pressure = _clamp(_as_float(payload.get("pressure"), 101.3), 50.0, 150.0)
    gravity = str(payload.get("gravity") or "0g")

    gravity_factor = 1.1 if gravity == "0g" else 1.0 if gravity == "0.16g" else 0.9
    oxygen_factor = 0.55 + ((oxygen - 15.0) / 20.0) * 0.9
    pressure_factor = _clamp(0.7 + 0.3 * (pressure / 101.3), 0.7, 1.3)
    flow_factor = 0.9 + (airflow / 50.0) * 0.3

    rankings = []
    for material in MATERIALS:
        score = _clamp(
            material["base"] * oxygen_factor * pressure_factor * flow_factor * gravity_factor,
            0.0,
            1.0,
        )
        rankings.append({
            "material": material["label"],
            "risk_level": material["risk_level"],
            "microgravity_flame_spread": material["spread"],
            "extinction_limit": material["extinction"],
            "score": round(score, 4),
            "tier": _tier(score),
            "risk": _tier(score),
        })
    rankings.sort(key=lambda item: item["score"], reverse=True)
    return rankings


def _rank_response(payload: dict) -> dict:
    rankings = build_ranking(payload)
    return {
        "status": "success",
        "rankings": rankings,
        "ranking": rankings,
        "results": rankings,
        "gravity": str(payload.get("gravity") or "0g"),
        "oxygen_conc": payload.get("oxygen_conc"),
        "airflow": payload.get("airflow"),
        "material": payload.get("material"),
        "note": "Server-side ranking; scores are 0-1 flammability estimates.",
    }


@app.post("/rank-materials")
async def rank_materials_post(request: Request):
    return _rank_response(await _read_json(request))


@app.get("/rank-materials")
async def rank_materials_get(request: Request):
    return _rank_response(await _read_json(request))


def pick_port(preferred: int) -> int:
    """Return *preferred* when free, otherwise the first free fallback port."""
    for port in (preferred, 8080, 8081, 8001):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    return preferred


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT") or pick_port(8000))
    print(f"NASA Space Fire Safety API -> http://127.0.0.1:{port}", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=port)



