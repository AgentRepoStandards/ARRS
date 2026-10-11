# Runtime audit requires explicit execution

A repository audit must distinguish documented capability from observed runtime success, but auditing an unfamiliar repository must not silently execute its code. Static audit is the default and runtime controls require `--execute`. Consequently level 2 and above require executed evidence; execution remains the caller's trust decision rather than a sandbox guarantee.
