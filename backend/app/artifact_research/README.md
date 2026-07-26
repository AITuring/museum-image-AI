# Artifact Research Agent

This package owns evidence retrieval for artifact cataloging. It is deliberately
separate from image recognition, EXIF writing, description generation, and cloud
ingest.

## Current responsibilities

1. Normalize the four catalog clues: artifact name, era, museum, and excavation.
2. Build focused search queries.
3. Run Qwen web research and independent web search concurrently.
4. Preserve the evidence bundle and research report in PostgreSQL.
5. Return a stable `ArtifactResearchRead` contract to any caller.
6. Reuse a persisted result when the same query and Agent version are requested.

The quick-entry description workflow consumes this evidence bundle. Qwen and
Doubao remain writers; they do not own research orchestration.

## Public API

- `GET /api/artifact-research/status`
- `POST /api/artifact-research/run`
- `GET /api/artifact-research/{research_id}`

## Knowledge-base extension point

`knowledge.py` defines the `KnowledgeProvider` protocol. The current
`DisabledKnowledgeProvider` always returns an empty evidence list. No PDF upload,
parsing, embedding, or vector table is implemented yet.

A future PDF knowledge-base provider should implement:

```python
class PdfKnowledgeProvider:
    async def search(
        self,
        query: ArtifactResearchQuery,
        *,
        top_k: int,
    ) -> list[ArtifactResearchSourceRead]:
        ...

    def revision(self) -> str:
        ...

    def enabled(self) -> bool:
        return True
```

The returned evidence must include a stable document identifier, page range,
excerpt, score, and citation URL. Its `revision()` value participates in the
research cache key, so uploading or rebuilding documents can invalidate old
research results without changing Agent consumers.

Planned PDF pipeline:

1. Store the original PDF and SHA-256.
2. Extract selectable text page by page; send scanned pages through OCR.
3. Preserve headings, page ranges, tables, and captions.
4. Split into citation-safe chunks.
5. Create dense and keyword indexes.
6. Retrieve candidates with hybrid search and rerank them.
7. Return only excerpts that can be traced to a document and page.

The future provider should remain replaceable. The Agent must not depend on a
specific vector database, embedding model, or PDF parser.
