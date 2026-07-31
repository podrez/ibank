-- Drop iParitet rows that were stored from an authorisation hold rather than a
-- posted operation. Such a hold has no operationId, so it was keyed by its RRN
-- (a 12-digit number) instead of the bank's 9-digit document id — and the bank's
-- own statement never lists it, either on its own or beside the posted copy.
-- Scrapers no longer store pending operations at all; this clears what the
-- earlier behaviour left behind.
DELETE FROM transactions
WHERE bank = 'iparitet'
  AND length(tx_key) = 12
  AND tx_key NOT GLOB '*[^0-9]*';
