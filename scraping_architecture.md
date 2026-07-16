# Greek Law Scraping & Processing Architecture

## 1. Overview
This document outlines a scalable, resilient scraping architecture designed to aggregate legal documents, legislation, and regulations related to Greek laws from various national and international sources.

The primary goal is to gather raw textual and structural data (Law Text, PDFs, Metadata) so that downstream Natural Language Processing (NLP) or AI systems can extract actionable "compliance tasks" for end users.

## 2. Target Sources
The system will target the following legal repositories:

### National Sources
* **Hellenic Parliament (hellenicparliament.gr):** Primary source for bills, laws, and parliamentary debates.
* **Official Gazette / FEK (gov.gr / et.gr):** The ultimate source of truth for passed and published laws.
* **N-Lex (europa.eu):** European portal gateway to Greek national legislation.

### International Organizations & Databases
* **IPU National Parliaments & Parline:** Data on the Hellenic Parliament structure and procedures.
* **ECOLEX:** Environmental law repository (Greece specific).
* **FAOLEX:** Food, agriculture, and renewable natural resources law (Greece specific).
* **NATLEX:** Labor, social security, and human rights legislation (Greece specific).
* **WIPO Lex:** Intellectual property legislation (Greece specific).

## 3. Technology Stack
* **Language:** Python 3.10+
* **Scraping Frameworks:**
  * `BeautifulSoup4` + `Requests`: For static HTML pages and simple APIs.
  * `Playwright` / `Selenium`: For dynamically loaded, JavaScript-heavy portals (e.g., modern Gov.gr search interfaces).
* **Document Parsing:** `PyPDF2` or `pdfplumber` to extract text from downloaded PDFs, especially scanned legacy FEKs.
* **Data Storage:** Output to structured `JSON` files.
* **Workflow Orchestration:** `Airflow` or `Cron` for scheduling daily incremental runs.

## 4. Data Schema (JSON)
The scrapers will normalize data from all sources into a unified JSON structure:

```json
{
  "id": "uuid",
  "source": "Official Gazette (FEK)",
  "law_title": "Title of the Law / Act",
  "law_number": "e.g., 4622/2019",
  "fek_reference": "A' 133/07.08.2019",
  "publication_date": "2019-08-07",
  "source_url": "https://url-to-original-document",
  "pdf_url": "https://url-to-pdf",
  "full_text": "Extracted raw text of the law...",
  "status": "Active",
  "metadata": {
    "tags": ["environment", "agriculture"]
  },
  "scraped_at": "2023-10-25T14:30:00Z"
}
```

## 5. Scraping Strategy
### Phase 1: Bulk Historical Scrape
* Initial extraction of all available historical records from each source.
* Implemented with high concurrency (using `asyncio`/`aiohttp`) but strict rate limiting to avoid overloading government servers.

### Phase 2: Daily Incremental Scrape
* Lightweight daily tasks that filter target websites for documents published within the last 24-48 hours.
* Compares found records against the existing database to avoid duplicates.

## 6. Resilience and Ethics (Best Practices)
* **Rate Limiting:** Maximum 1-2 requests per second per IP.
* **Headers:** Rotate User-Agents and provide a contact email in the header.
* **Retries & Logging:** Implement exponential backoff for 5xx server errors, common in older government portals.
* **Robots.txt:** Always check and adhere to `robots.txt` guidelines.

## 7. Next Steps for Integration
1. Execute the Python scraper to generate the JSON dataset.
2. Load JSON data into a vector database or search index (e.g., Elasticsearch, Pinecone).
3. Connect an LLM to read the `full_text` and output actionable user tasks (e.g., "Renew agricultural permit by X date").
