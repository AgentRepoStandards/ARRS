# Separate normalization from delivery

The domain owns recipient normalization while the application owns delivery. This keeps the display policy testable without subprocess I/O and allows replacing delivery without changing the salutation rule.
