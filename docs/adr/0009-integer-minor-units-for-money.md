# Integer minor units for money

PocketCircle stores Transaction Amounts as positive integer minor units and performs dashboard, search, and export calculations using integers. This avoids floating-point rounding errors while keeping the v1 UI constrained to two decimal places across supported currencies.
