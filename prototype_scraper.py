#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""prototype_scraper.py — Greek law scraper (real fetch path, Phase 1-8).

Output feeds `backend/src/scripts/ingestLegislation.js` via
`scraped_laws.json` (schema per `scraping_architecture.md` §4).

Requirements (install once — the repo has no Python dependency manager):
    pip install requests beautifulsoup4

`requests` + `beautifulsoup4` are imported lazily inside the real fetch
path, so `--simulate` (offline fixture generation) and `python3 -m
py_compile prototype_scraper.py` work with the stdlib alone.

Usage:
    # Real scrape of a listing/search page → scraped_laws.json
    python3 prototype_scraper.py --url https://www.hellenicparliament.gr/...

    # Inspect what would be written, without writing anything
    python3 prototype_scraper.py --url https://example.gov.gr/search?q=laws --dry-run

    # Offline fixture generation (no network, no third-party imports)
    python3 prototype_scraper.py --simulate --dry-run

Ethics/compliance (scraping_architecture.md §6):
    * robots.txt is fetched and adhered to (RFC 9309 semantics; missing
      4xx robots.txt → allow, 5xx/unreachable → treat as disallowed).
    * Per-host rate limiting: at most one request per `--min-interval`
      seconds (default 1.0 → 1 req/s; the architecture caps at 1-2 req/s
      per IP), raised further if robots.txt declares a Crawl-delay.
    * Rotating User-Agent strings + a `From:` contact address header.
    * Exponential backoff retries for 5xx/429 (architecture §6).
"""

import argparse
import datetime
import json
import logging
import re
import time
import uuid
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

# Setting up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# scraping_architecture.md §6: "provide a contact email in the header".
CONTACT_EMAIL = "ops@nomosai.example"

# Rotated round-robin per request (architecture §6: "Rotate User-Agents").
USER_AGENTS = [
    "NomosAI-LawBot/0.2 (+https://nomosai.example; ops@nomosai.example)",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
]

# Architecture §6: maximum 1-2 requests/second per IP.
DEFAULT_MIN_INTERVAL = 1.0
DEFAULT_TIMEOUT = 20.0
DEFAULT_MAX_RETRIES = 3
INITIAL_BACKOFF_SECONDS = 1.0
# HTTP statuses worth retrying with exponential backoff.
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})

# Built-in fixture HTML (same markup the old simulator emitted). Used by
# `--simulate` so downstream parsing/ingest logic can be exercised offline.
SIMULATED_HTML = (
    "<html><body><div class='law-entry'>"
    "<h3>Law 4622/2019</h3>"
    "<span class='date'>07-08-2019</span>"
    "<span class='fek'>FEK A' 133</span>"
    "<a href='/pdf/4622.pdf'>Download PDF</a>"
    "<p class='text'>Executive State: organization, operation and transparency "
    "of the Government, governmental organs and the central public administration.</p>"
    "</div></body></html>"
)

SIMULATED_SOURCE_URL = "https://example.gov.gr/search?q=laws"

# Greek-language content keyed on law number so the prototype emits
# content in the same language as the user-facing prompts. Without this
# mapping, the embed model (`nomic-embed-text`) clusters Greek queries
# ~0.50 similarity to the English record while Greek-to-Greek matches
# land at ~0.72 — the Greek mocks would always win the top-K and the
# real scraped law would never be retrieved (Phase 29 diagnostic).
GREEK_LAW_CONTENT = {
    "4622/2019": {
        "title": "Οργάνωση, λειτουργία και διαφάνεια της Κυβέρνησης",
        "full_text": (
            "Ο παρών νόμος ρυθμίζει την οργάνωση, λειτουργία και "
            "διαφάνεια της Κυβέρνησης, των κυβερνητικών οργάνων και της "
            "κεντρικής δημόσιας διοίκησης. Θεσπίζει τη δομή του "
            "Υπουργικού Συμβουλίου, τις αρμοδιότητες των Υπουργών, "
            "Αναπληρωτών Υπουργών και Υφυπουργών, και τις σχέσεις "
            "μεταξύ των κυβερνητικών οργάνων. Καθιερώνει κανόνες "
            "διαφάνειας για τη λειτουργία της εκτελεστικής εξουσίας, "
            "ρυθμίζει τη σύσταση και τη λειτουργία των γενικών και "
            "ειδικών γραμματειών, ορίζει τις προϋποθέσεις ανάθεσης "
            "αρμοδιοτήτων και θέσπιζει μεταβατικές διατάξεις για την "
            "ομαλή μετάβαση στη νέα κυβερνητική δομή."
        ),
    },
    "3852/2010": {
        "title": "Πρόγραμμα Καλλικράτης — Αιρετές Περιφέρειες",
        "full_text": (
            "Ο παρών νόμος, γνωστός ως Πρόγραμμα Καλλικράτης, "
            "ρυθμίζει τη νέα αρχιτεκτονική της τοπικής αυτοδιοίκησης "
            "στην Ελλάδα. Συγχωνεύει τους δήμους σε μεγαλύτερους "
            "δήμους, αναδιαρθρώνει τις περιφέρειες ως αιρετές "
            "αυτοδιοικήσεις και ορίζει τις αρμοδιότητες, τα "
            "όργανα και τη χρηματοδότηση των νέων ΟΤΑ. Θεσπίζει "
            "το Περιφερειακό Συμβούλιο, τον Περιφερειάρχη και την "
            "Οικονομική Επιτροπή, καθώς και τις σχέσεις τους με "
            "τους δήμους και την κεντρική κυβέρνηση."
        ),
    },
    "2690/1999": {
        "title": "Κώδικας Διοικητικής Διαδικασίας",
        "full_text": (
            "Ο Κώδικας Διοικητικής Διαδικασίας ρυθμίζει τη "
            "διαδικασία έκδοσης διοικητικών πράξεων, τις "
            "υποχρεώσεις των διοικητικών οργάνων και τα "
            "δικαιώματα των διοικουμένων. Θεσπίζει αρχές όπως "
            "η νομιμότητα, η αιτιολόγηση και η ακρόαση του "
            "ενδιαφερομένου, και ορίζει τις προθεσμίες και τις "
            "συνέπειες της παράλειψης οφειλόμενης ενέργειας."
        ),
    },
}

# Default Greek template for any law number not present in the map
# above. Keeps the prototype producing Greek content end-to-end so the
# RAG retrieval path remains useful even before a real scraper lands.
GREEK_DEFAULT_FULL_TEXT_TEMPLATE = (
    "Ο νόμος {law_num} περιλαμβάνει διατάξεις οι οποίες "
    "ρυθμίζουν ζητήματα που σχετίζονται με τον τίτλο του "
    "νόμου και θέτουν το κανονιστικό πλαίσιο για την εφαρμογή "
    "του στην ελληνική έννομη τάξη. Ειδικότερα, ορίζονται "
    "αρμοδιότητες, διαδικασίες και μεταβατικές διατάξεις για "
    "την ομαλή εφαρμογή του."
)


def greek_content_for(law_num: str) -> dict:
    """Return a `{title, full_text}` record in Greek for the given law.

    Falls back to a Greek template for unknown numbers so the prototype
    never emits English content even if the hard-coded HTML has a number
    we haven't translated yet.
    """
    if law_num in GREEK_LAW_CONTENT:
        return GREEK_LAW_CONTENT[law_num]
    return {
        "title": f"Ελληνικός νόμος {law_num}",
        "full_text": GREEK_DEFAULT_FULL_TEXT_TEMPLATE.format(law_num=law_num),
    }


def normalize_date(value: str) -> str:
    """Best-effort ISO date normalization for scraped `dd-mm-yyyy` stamps."""
    value = (value or "").strip()
    for separator in ("-", ".", "/"):
        parts = value.split(separator)
        if len(parts) == 3 and all(p.isdigit() for p in parts):
            day, month, year = parts
            if len(year) == 4:
                return f"{year}-{month.zfill(2)}-{day.zfill(2)}"
    return value


class GreekLawScraperPrototype:
    """Fetch + parse + normalize Greek law listings.

    The real path (default) uses `requests` + BeautifulSoup, checks
    robots.txt, rate-limits per host, rotates User-Agents and retries
    5xx/429 with exponential backoff. `--simulate` keeps the old offline
    fixture generator behavior for tests/fixture regeneration.
    """

    def __init__(self, base_url, min_interval=DEFAULT_MIN_INTERVAL,
                 timeout=DEFAULT_TIMEOUT, max_retries=DEFAULT_MAX_RETRIES,
                 respect_robots=True):
        self.base_url = base_url
        self.min_interval = max(0.0, float(min_interval))
        self.timeout = timeout
        self.max_retries = max(1, int(max_retries))
        self.respect_robots = respect_robots
        self.session = None
        # Per-host polite-scraping state.
        self._last_request_at = {}
        self._robots = {}
        self._ua_index = 0

    # ------------------------------------------------------------------
    # Real fetch path (requests + robots.txt + rate limiting + retries)
    # ------------------------------------------------------------------
    def _get_session(self):
        if self.session is None:
            try:
                import requests  # lazy: keeps --simulate stdlib-only
            except ImportError as exc:  # pragma: no cover - env-dependent
                raise RuntimeError(
                    "Real scraping requires the 'requests' package "
                    "(pip install requests beautifulsoup4). "
                    "Use --simulate for offline fixture generation."
                ) from exc
            self.session = requests.Session()
        return self.session

    def _next_user_agent(self) -> str:
        ua = USER_AGENTS[self._ua_index % len(USER_AGENTS)]
        self._ua_index += 1
        return ua

    def _throttle(self, url: str) -> None:
        """Sleep so consecutive requests to the same host stay >= the
        effective interval apart (also honors robots.txt Crawl-delay)."""
        host = urlparse(url).netloc
        delay = self.min_interval
        parser = self._robots.get(host)
        if parser is not None and not parser.disallow_all:
            crawl_delay = parser.crawl_delay("*")
            if crawl_delay:
                delay = max(delay, float(crawl_delay))
        last = self._last_request_at.get(host)
        if last is not None:
            remaining = delay - (time.monotonic() - last)
            if remaining > 0:
                logging.debug("Rate limiting %s: sleeping %.2fs", host, remaining)
                time.sleep(remaining)
        self._last_request_at[host] = time.monotonic()

    def robots_allowed(self, url: str) -> bool:
        """Fetch + cache /robots.txt per host; RFC 9309 semantics:
        unparseable 4xx (e.g. 404) → allow all, 5xx/unreachable → disallow.
        """
        if not self.respect_robots:
            return True
        parsed = urlparse(url)
        host = parsed.netloc
        parser = self._robots.get(host)
        if parser is None:
            robots_url = f"{parsed.scheme}://{host}/robots.txt"
            parser = RobotFileParser()
            parser.set_url(robots_url)
            try:
                self._throttle(robots_url)
                response = self._get_session().get(
                    robots_url,
                    headers={"User-Agent": USER_AGENTS[0], "From": CONTACT_EMAIL},
                    timeout=self.timeout,
                )
                if 200 <= response.status_code < 300:
                    parser.parse(response.text.splitlines())
                elif 400 <= response.status_code < 500:
                    # RFC 9309 §2.3.1.3: "unavailable" 4xx → allow all.
                    parser.parse([])
                    logging.info(
                        "No robots.txt at %s (HTTP %d) — assuming all paths allowed.",
                        robots_url, response.status_code,
                    )
                else:
                    # RFC 9309 §2.3.1.4: 5xx → treat as complete disallow.
                    logging.warning(
                        "robots.txt at %s returned HTTP %d; treating host as disallowed.",
                        robots_url, response.status_code,
                    )
                    parser.disallow_all = True
            except Exception as exc:
                logging.warning(
                    "Could not fetch %s (%s); treating host as disallowed (RFC 9309).",
                    robots_url, exc,
                )
                parser.disallow_all = True
            self._robots[host] = parser
        return parser.can_fetch("*", url)

    def fetch_page(self, url: str, simulate: bool = False) -> str:
        """Fetch one HTML page (real HTTP by default).

        `simulate=True` returns the built-in fixture HTML instead of
        touching the network — used by `--simulate` and fixture tests.
        """
        if simulate:
            logging.info("Simulate mode: returning built-in fixture HTML for %s", url)
            return SIMULATED_HTML

        if not self.robots_allowed(url):
            raise PermissionError(f"robots.txt disallows crawling {url}")

        session = self._get_session()
        backoff = INITIAL_BACKOFF_SECONDS
        last_error = None

        for attempt in range(1, self.max_retries + 1):
            self._throttle(url)
            headers = {
                "User-Agent": self._next_user_agent(),
                "From": CONTACT_EMAIL,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "el,en;q=0.8",
            }
            try:
                response = session.get(url, headers=headers, timeout=self.timeout)
            except Exception as exc:  # network-level failure
                last_error = exc
            else:
                if response.status_code < 400:
                    logging.info("Fetched %s (HTTP %d, %d bytes)",
                                 url, response.status_code, len(response.content))
                    return response.text
                if response.status_code in RETRYABLE_STATUS and attempt < self.max_retries:
                    last_error = RuntimeError(f"HTTP {response.status_code}")
                else:
                    # 4xx / non-retryable: fail immediately so operators
                    # see a broken URL rather than a silent empty run.
                    raise RuntimeError(
                        f"Fetch failed for {url}: HTTP {response.status_code}"
                    )

            if attempt < self.max_retries:
                logging.warning(
                    "Retry %d/%d for %s in %.1fs (%s)",
                    attempt, self.max_retries - 1, url, backoff, last_error,
                )
                time.sleep(backoff)
                backoff *= 2

        raise RuntimeError(
            f"Giving up on {url} after {self.max_retries} attempts: {last_error}"
        )

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------
    def parse_laws(self, html: str):
        """Parse a listing page into raw `{title, law_num, date, fek,
        pdf_link, text}` records (BeautifulSoup). Returns [] when the
        page has no `.law-entry` blocks."""
        try:
            from bs4 import BeautifulSoup  # lazy: keeps --simulate stdlib-only
        except ImportError as exc:  # pragma: no cover - env-dependent
            raise RuntimeError(
                "Real HTML parsing requires 'beautifulsoup4' "
                "(pip install requests beautifulsoup4)."
            ) from exc

        logging.info("Parsing HTML content...")
        soup = BeautifulSoup(html, "html.parser")
        records = []
        for entry in soup.select("div.law-entry"):
            heading = entry.find(["h1", "h2", "h3", "h4"])
            title = heading.get_text(" ", strip=True) if heading else ""
            match = re.search(r"(\d+)\s*/\s*(\d{4})", title)
            law_num = f"{match.group(1)}/{match.group(2)}" if match else title

            fek_el = entry.select_one(".fek")
            date_el = entry.select_one(".date")
            text_el = entry.select_one(".text")
            if text_el is None:
                paragraphs = entry.find_all("p")
                text = " ".join(p.get_text(" ", strip=True) for p in paragraphs)
            else:
                text = text_el.get_text(" ", strip=True)
            pdf_el = entry.find("a", href=re.compile(r"\.pdf($|\?)", re.IGNORECASE))

            records.append({
                "title": title or f"Law {law_num}",
                "law_num": law_num,
                "date": normalize_date(date_el.get_text(strip=True)) if date_el else "",
                "fek": fek_el.get_text(strip=True) if fek_el else "",
                "pdf_link": pdf_el.get("href", "") if pdf_el else "",
                "text": text,
            })
        return records

    def _simulated_records(self):
        """Offline fixture records: same shape as parse_laws() output but
        with the Greek content map applied (Phase 29 diagnostic above)."""
        try:
            records = self.parse_laws(SIMULATED_HTML)
        except RuntimeError:
            records = []  # bs4 not installed — --simulate stays stdlib-only
        if records:
            for record in records:
                greek = greek_content_for(record["law_num"])
                record["title"] = greek["title"]
                record["text"] = greek["full_text"]
            return records

        greek = greek_content_for("4622/2019")
        return [{
            "title": greek["title"],
            "law_num": "4622/2019",
            "date": "2019-08-07",
            "fek": "A' 133",
            "pdf_link": "/pdf/4622.pdf",
            "text": greek["full_text"],
        }]

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------
    def process_and_export(self, search_url, output_filename="scraped_laws.json",
                           dry_run=False, simulate=False):
        """Main workflow: fetch, parse, normalize, and save to JSON.

        `dry_run=True` prints the JSON to stdout and writes NOTHING (safe
        inspection / fixture capture).
        """
        if simulate:
            raw_laws = self._simulated_records()
            source_label = "Prototype Simulator (gov.gr)"
        else:
            html = self.fetch_page(search_url)
            raw_laws = self.parse_laws(html)
            source_label = f"Scraped ({urlparse(search_url).netloc})"

        formatted_laws = []
        for raw in raw_laws:
            law_data = {
                "id": str(uuid.uuid4()),
                "source": source_label,
                "law_title": raw["title"],
                "law_number": raw["law_num"],
                "fek_reference": raw["fek"],
                "publication_date": raw["date"],
                "source_url": search_url,
                "pdf_url": urljoin(self.base_url, raw["pdf_link"]) if raw.get("pdf_link") else None,
                "full_text": raw["text"],
                "status": "Active",
                "scraped_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
            formatted_laws.append(law_data)
            logging.info("Processed Law: %s", law_data["law_number"])

        if dry_run:
            print(json.dumps(formatted_laws, ensure_ascii=False, indent=2))
            logging.info(
                "Dry run: printed %d law(s) to stdout; %s NOT written.",
                len(formatted_laws), output_filename,
            )
            return formatted_laws

        with open(output_filename, 'w', encoding='utf-8') as f:
            json.dump(formatted_laws, f, ensure_ascii=False, indent=2)

        logging.info("Successfully exported %d laws to %s",
                     len(formatted_laws), output_filename)
        return formatted_laws


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Greek law scraper prototype (writes scraped_laws.json "
                    "for backend/src/scripts/ingestLegislation.js).",
    )
    parser.add_argument("--url", default=None,
                        help="Listing/search page to scrape (required unless --simulate).")
    parser.add_argument("--base-url", default=None,
                        help="Base URL for resolving relative PDF links; "
                             "defaults to --url's scheme+host.")
    parser.add_argument("--output", default="scraped_laws.json",
                        help="Output JSON path (default: scraped_laws.json).")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print JSON to stdout; write no files.")
    parser.add_argument("--simulate", action="store_true",
                        help="Offline fixture mode: emit the built-in Greek "
                             "sample instead of fetching (no third-party deps).")
    parser.add_argument("--min-interval", type=float, default=DEFAULT_MIN_INTERVAL,
                        help="Minimum seconds between requests to one host "
                             "(default: 1.0 => 1 req/s).")
    args = parser.parse_args(argv)

    if args.simulate:
        url = args.url or SIMULATED_SOURCE_URL
    elif args.url:
        url = args.url
    else:
        parser.error("--url is required unless --simulate is passed")

    parsed = urlparse(url)
    base_url = args.base_url or f"{parsed.scheme}://{parsed.netloc}"

    scraper = GreekLawScraperPrototype(base_url=base_url, min_interval=args.min_interval)
    scraper.process_and_export(
        url,
        output_filename=args.output,
        dry_run=args.dry_run,
        simulate=args.simulate,
    )


if __name__ == "__main__":
    main()
