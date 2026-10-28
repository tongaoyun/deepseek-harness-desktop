# External expert test fixtures

These Markdown trees are test inputs for the product expert catalog, not runtime experts or independently installed plugins. Their source references and licenses are maintained with the [product expert module](../../packages/deepseek-harness-product/experts/README.md).

Local format corrections quote the `descriptionEn` YAML scalar in `agency-agents/engineering/engineering-ai-data-remediation-engineer.md`, `agency-agents/engineering/engineering-developer-tooling-engineer.md`, and `agency-agents/specialized/zk-steward.md`. The decoded descriptions and persona bodies are unchanged; unquoted colon-space sequences in these descriptions are invalid YAML. The catalog tests parse both language trees through the native document reader.
