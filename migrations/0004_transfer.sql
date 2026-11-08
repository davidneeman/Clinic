-- Paying by Bit or PayBox to the practitioner's phone (BOOKING_MODE "transfer"): what the client
-- chose to pay for, and when David saw the payment and approved the booking.
--   plan: 'single' (one session), 'pack' (the 4-session card, this session included) or
--         'card' (a session from a card the client already has)
ALTER TABLE bookings ADD COLUMN plan TEXT;
ALTER TABLE bookings ADD COLUMN approved_at TEXT;
