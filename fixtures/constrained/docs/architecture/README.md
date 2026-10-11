# Task preview modules

Application owns CLI parsing and rendering. Domain owns task title normalization and queued state. A reverse dependency from domain to application is forbidden in the constrained and self-verifying examples; the gate exercises that boundary.
