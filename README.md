AETHON

AI-Powered Space Fire Safety & Microgravity Combustion Intelligence Platform

Built for the NASA Space Apps Challenge 2026 — "Flame in Freefall: AI-Powered Fire Safety Insights from Microgravity Combustion"

📖 Overview

microcombust is a full-stack Retrieval-Augmented Generation (RAG) and material risk-assessment platform designed for aerospace engineers, fire safety researchers, and mission planners. By indexing over 40+ technical papers from NASA’s Physical Sciences Informatics (PSI) database, microcombust transforms dense microgravity combustion studies into actionable safety insights.

In microgravity and partial-gravity environments (such as the ISS, lunar habitats, or transit vehicles), the absence of buoyancy-driven convection dramatically alters flame ignition, spread, smoke dynamics, and extinguishment. microcombust bridges the gap between raw experimental archives and practical spacecraft fire safety protocols.

#Key Features

#NASA Literature RAG Agent (/query-agent): Ask natural-language questions about microgravity combustion, SAFFIRE experiments, smoke aerosol behavior, and flame spread—grounded directly in NASA technical publications.

#Combustion Physics Validation: Automatically inspects queried environmental parameters (oxygen percentage, fuel types, pressure) and flags physically impossible or hazardous conditions via _validate_combustion_conditions.

📊 Material Flammability Risk Ranking (/rank-materials): Computes normalized flammability hazard scores ($0.0\text{--}1.0$) across spacecraft materials based on custom inputs:

Oxygen concentration ($\%\text{ O}_2$)

Ambient pressure ($\text{kPa}$ / $\text{atm}$)

Airflow / ventilation velocity

Gravity level ($g$-force)

⚡ Resilient Multi-Tier LLM Pipeline:

Primary Inference: Groq (qwen/qwen3.8-27b) via an OpenAI-compatible interface for ultra-fast responses.

Automatic Failover: Seamless fallback to OpenRouter if Groq is unreachable.

Optional Reranking: Cohere Rerank integration for higher-precision context retrieval.

🖥️ Interactive Web Dashboard (microcombust-ui): Modern Next.js App Router frontend for querying literature, inspecting safety warnings, and comparing material risk profiles.

🏗️ System Architecture

microcombust/
├── papers/                  # 40+ NASA PSI & SAFFIRE technical PDFs
├── chroma_db/               # Local persistent vector database (chroma.sqlite3)
├── microcombust-ui/         # Next.js 14+ frontend dashboard (App Router)
│   ├── app/                 # Pages, UI components, and API integrations
│   ├── public/              # Static assets
│   └── package.json         # Node dependencies
├── ingest.py                # PDF extraction, chunking & ChromaDB embedding script
├── main.py                  # FastAPI backend server & RAG/Ranking endpoints
├── requirements.txt         # Python dependencies
└── .env                     # API keys and environment configuration


How the Pipeline Works

Ingestion (ingest.py):

Scans papers/ for NASA PDF publications.

Extracts text using pypdf and splits content into overlapping semantic chunks (~1,000 characters with a 200-character overlap).

Generates dense vector embeddings locally using SentenceTransformers (all-MiniLM-L6-v2) and stores them in the microcombust_papers ChromaDB collection.

Retrieval & Generation (main.py):

Validates incoming user queries and atmospheric conditions.

Performs vector similarity search (with optional Cohere reranking) to fetch the most relevant research excerpts.

Synthesizes clear, technically accurate answers via Groq or OpenRouter.

Flammability Scoring (main.py):

Applies material baseline flammability properties alongside environmental multipliers (oxygen, pressure, airflow, and gravity) to output a standardized $0\text{--}1$ risk index.

🚀 Getting Started

Prerequisites

Python 3.10+

Node.js 18+ & npm/yarn

API Keys for Groq (primary) and optionally OpenRouter / Cohere

1. Clone the Repository

git clone https://github.com/yourusername/microcombust.git
cd microcombust


2. Backend Setup

Create a virtual environment and install the required Python packages:

python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt


Create a .env file in the root directory and configure your API keys:

GROQ_API_KEY=your_groq_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here
COHERE_API_KEY=your_cohere_api_key_here   # Optional: enables passage reranking
PORT=8000


3. Ingest NASA Research Papers

Place your NASA PSI PDF documents inside the papers/ directory, then run the ingestion pipeline to build the local vector database:

python ingest.py


4. Start the FastAPI Backend

python main.py


The API server will start on http://localhost:8000 (with automatic port fallback if occupied).

5. Start the Frontend Dashboard

Open a new terminal, navigate to the UI directory, install dependencies, and launch the development server:

cd microcombust-ui
npm install
npm run dev


Access the dashboard in your browser at http://localhost:3000.

🔌 API Reference

Method

Endpoint

Description

GET

/

Health check probe and service status.

POST

/query-agent

Submit a natural-language question (query or question) to the NASA RAG agent.

GET / POST

/rank-materials

Calculate flammability risk scores (0–1) based on oxygen_conc, airflow, pressure, and gravity.

Example RAG Request

curl -X POST http://localhost:8000/query-agent \
  -H "Content-Type: application/json" \
  -d '{"question": "How does low-velocity airflow affect flame spread over solid fuels in microgravity?"}'


Example Material Ranking Request

curl -X POST http://localhost:8000/rank-materials \
  -H "Content-Type: application/json" \
  -d '{
    "oxygen_conc": 32.0,
    "airflow": 0.15,
    "pressure": 70.3,
    "gravity": 0.16
  }'


🛠️ Tech Stack

Backend: Python, FastAPI, Uvicorn, Pydantic, Tenacity

AI & Vector Search: ChromaDB, SentenceTransformers (all-MiniLM-L6-v2), Groq (qwen/qwen3.8-27b), OpenRouter, Cohere Rerank, pypdf

Frontend: Next.js 14+ (App Router), TypeScript, Tailwind CSS

Data Source: NASA Physical Sciences Informatics (PSI) System

🌍 Space-to-Earth Impact

Lunar & Martian Habitat Safety: Helps engineers evaluate fire risks in exploration atmospheres (e.g., $32\%\text{ O}_2$ at $70.3\text{ kPa}$ used to prevent decompression sickness).

Terrestrial Fire Suppression: Insights surfaced from microgravity aerosol dynamics and SAFFIRE experiments support next-generation smart smoke detectors and fine water-mist fire suppression systems on Earth.

📄 License

Developed for the NASA Space Apps Challenge 2026. Research documents indexed in papers/ belong to NASA's public Physical Sciences Informatics (PSI) repository.
