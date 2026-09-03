-- Which cards players BRING, aggregated across the community. Opt-in.
--
-- This is the one thing in the project that carries data off a player's own disk, so read
-- what it is and is not before extending it.
--
-- IT IS NOT WHAT THEY PLAYED. A recording carries neither the card played nor the deck it
-- came from — the engine plays a card by DECK SLOT and never transmits an identifier, which
-- is settled from the engine's own API rather than from a failed search (see the card
-- section of the launcher's .claude/rules/multiplayer.md). A deck holds 25 cards and a match
-- may use five. Every surface has to say "brings", never "plays".
--
-- IT IS SELF-DECLARED AND UNVERIFIABLE. The deck lives in a file on that player's machine;
-- the server cannot check that what it receives is what was taken into any match, and there
-- is no match here to check it against. That is acceptable for a popularity table and it is
-- why nothing derived from this may ever reach the rating path.
--
-- ONE ROW PER (user, mod, civ, card), so the primary key does the deduplication and an
-- upload REPLACES that player's rows rather than appending to them. Without that, a player
-- who opens the launcher every day counts as a new player every day and the table measures
-- how often people restart it.
--
-- The card is stored by its INTERNAL name, not its DBID: the id space is per mod and the
-- name is what techtreey.xml keys on, so a row stays readable in a query and a mod that
-- renumbers its tech tree does not silently re-point every row at a different card. Naming
-- it for display is the launcher's job (CardNameResolver, 97.2% of Wars of Liberty's 4,517).
--
-- No civilization DISPLAY name is stored either, for the same reason it is not stored on
-- matches: a mod that reskins a base civ keeps the internal name, and the launcher resolves
-- it through that mod's own string table.
CREATE TABLE deck_cards (
    user_id TEXT NOT NULL,
    mod_id  TEXT NOT NULL,
    civ     TEXT NOT NULL,
    card    TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, mod_id, civ, card),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- The aggregate reads (mod, civ, card) and counts distinct users; the delete-before-insert
-- of an upload reads (user, mod, civ). The primary key already serves the second.
CREATE INDEX idx_deck_cards_agg ON deck_cards (mod_id, civ, card);
