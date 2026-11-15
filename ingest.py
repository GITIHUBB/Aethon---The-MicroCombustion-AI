import os
from pypdf import PdfReader
import chromadb
from sentence_transformers import SentenceTransformer

PAPERS_DIR = "papers"
DB_PATH = "chroma_db"

def run_ingestion():
    print("Initializing ChromaDB and embedding model...")
    client = chromadb.PersistentClient(path=DB_PATH)
    # Using a robust, lightweight local embedding model
    embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
    
    # Get or create collection
    collection = client.get_or_create_collection(name="microcombust_papers")

    pdf_files = [f for f in os.listdir(PAPERS_DIR) if f.endswith(".pdf")]
    print(f"Found {len(pdf_files)} PDF files in '{PAPERS_DIR}/'. Starting ingestion...")

    for filename in pdf_files:
        pdf_path = os.path.join(PAPERS_DIR, filename)
        print(f"Processing: {filename}")
        
        try:
            reader = PdfReader(pdf_path)
            full_text = ""
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    full_text += text + "\n"

            if not full_text.strip():
                print(f"  -> Warning: No text extracted from {filename} (might be image-only). Skipping.")
                continue

            # Simple chunking: split text into chunks of ~1000 characters with 200 char overlap
            chunk_size = 1000
            overlap = 200
            chunks = []
            for i in range(0, len(full_text), chunk_size - overlap):
                chunk = full_text[i:i + chunk_size]
                if len(chunk.strip()) > 50:  # ignore tiny trailing chunks
                    chunks.append(chunk.strip())

            if not chunks:
                continue

            print(f"  -> Generated {len(chunks)} chunks. Embedding and upserting...")
            
            # Generate vector embeddings locally
            embeddings = embedding_model.encode(chunks).tolist()
            
            # Prepare unique IDs and metadata for ChromaDB
            ids = [f"{filename}_chunk_{idx}" for idx in range(len(chunks))]
            metadatas = [{"source": filename, "chunk_index": idx} for idx in range(len(chunks))]

            # Upsert into ChromaDB
            collection.upsert(
                ids=ids,
                documents=chunks,
                embeddings=embeddings,
                metadatas=metadatas
            )
            print(f"  -> Successfully stored {filename} in ChromaDB.")

        except Exception as e:
            print(f"  -> Error processing {filename}: {e}")

    print("\nIngestion complete! All papers are now vectorized and indexed in ChromaDB.")

if __name__ == "__main__":
    run_ingestion()