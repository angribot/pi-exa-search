# Pi Exa Search

Pi Exa Search gives Pi Agent two Exa-backed web access capabilities: source discovery and page content retrieval. It does not own an end-to-end research workflow.

## Language

**Pi Agent**:
The Pi coding agent acting as the direct consumer of this context's web capabilities.
_Avoid_: User, researcher

**Exa**:
The external service supplying search results and extracted page content to Pi Exa Search.
_Avoid_: Generic provider, search backend

**Web Search**:
Exa-backed discovery of web sources matching a Search Query. It returns Search Results rather than complete page content.
_Avoid_: Research, keyword search

**Search Query**:
A natural-language description of desired information or an ideal source.
_Avoid_: Keywords, search terms

**Search Results**:
A collection of Exa-produced source summaries and highlights returned by Web Search.
_Avoid_: Pages, Page Content

**Page Fetch**:
Exa-backed retrieval of Page Content for one or more known HTTP(S) URLs.
_Avoid_: Web Search, crawl, raw download

**Page Content**:
Cleaned text or Markdown and metadata extracted by Exa for a requested URL. It may be limited and is not a completeness guarantee.
_Avoid_: Full page, raw HTML
