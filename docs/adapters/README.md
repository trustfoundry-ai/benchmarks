# Provider adapters

Each file in this directory describes one shipped provider adapter — what it wraps, how the harness talks to it, and what to expect when you run the benchmark against it.

The adapter set groups into two categories:

- **Legal-specific search engines** — [`trustfoundry-legal-search`](trustfoundry-legal-search.md), [`courtlistener-search`](courtlistener-search.md). These are search backends purpose-built for U.S. case law. Both TrustFoundry and CourtListener maintain their own corpora, court taxonomies, and rankers tuned for legal retrieval.
- **General-purpose LLMs and web search, adapted for legal** — [`anthropic-legal-search`](anthropic-legal-search.md), [`openai-legal-search`](openai-legal-search.md), [`exa-legal-search`](exa-legal-search.md). These adapters wrap a general LLM's built-in web-search tool (Anthropic, OpenAI) or a general semantic web-search API (Exa), coax it into returning ranked case-law citations, and hand those to the same scorer. They exist so evaluators can run those options against the same benchmark rows and scorer as everything else in this repo. TrustFoundry is not publishing head-to-head numbers against them; they're provided for evaluators to draw their own conclusions from.

If you're implementing a new adapter, see [`docs/adapter-contracts.md`](../adapter-contracts.md) for the contract and [`src/core/contracts/README.md`](../../src/core/contracts/README.md) for the adapter-authoring guide.
