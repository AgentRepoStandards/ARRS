# Versioned JSON contracts and executable argument vectors

ARRS v0.1 uses strict JSON schemas and repository commands represented as argument vectors. YAML and shell strings would be more permissive for authors but introduce parser ambiguity and implicit shell execution at the shared repository boundary. Explicit versions and `shell: false` make validation and command semantics portable; shell behaviour remains possible only through a deliberately configured executable.
