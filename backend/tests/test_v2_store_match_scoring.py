"""Store-name scoring: the quick_ratio prefilter keeps exactly the matches of scoring every label."""

from __future__ import annotations

import random
from difflib import SequenceMatcher

from app.api.v2.stores import NEAR_MATCH_SCORE, _best_label


def _score_every_label(query_key: str, labels: list[tuple[str, str]]):
    """The scoring /stores/matches used before the prefilter: ratio() of every label."""
    label, score = max(
        ((label, SequenceMatcher(None, query_key, key).ratio()) for label, key in labels),
        key=lambda item: item[1],
    )
    exact = any(key == query_key for _, key in labels)
    if not exact and score < NEAR_MATCH_SCORE:
        return None
    return exact, label, score


def _words(rng: random.Random, count: int) -> str:
    return " ".join("".join(rng.choice("abcdeilmnorstu0123") for _ in range(rng.randint(2, 9)))
                    for _ in range(count))


def _variant(rng: random.Random, text: str) -> str:
    """A near spelling: a few characters replaced, dropped or added."""
    chars = list(text)
    for _ in range(rng.randint(1, max(1, len(chars) // 4))):
        position = rng.randrange(len(chars) + 1)
        action = rng.choice(("replace", "drop", "add"))
        if action == "add" or not chars:
            chars.insert(position, rng.choice("abcdeilmnorstu "))
        elif position < len(chars):
            if action == "drop":
                del chars[position]
            else:
                chars[position] = rng.choice("abcdeilmnorstu ")
    return " ".join("".join(chars).split()) or "x"


def test_prefilter_returns_the_same_best_label_as_scoring_every_label():
    rng = random.Random(20261106)
    queries = [_words(rng, rng.randint(1, 4)) for _ in range(30)]
    queries += [_words(rng, rng.randint(40, 60)) for _ in range(6)]  # over 200 characters
    assert any(len(query) > 200 for query in queries)
    outcomes = {"exact": 0, "near": 0, "none": 0}
    for query in queries:
        for _ in range(12):
            keys = []
            for _ in range(rng.randint(1, 5)):
                kind = rng.random()
                if kind < 0.45:
                    keys.append(_variant(rng, query))
                elif kind < 0.55:
                    keys.append(query)  # an exact store name or approved alias
                else:
                    keys.append(_words(rng, rng.randint(1, 50)))
            labels = [(key.title() + " #" + str(index), key) for index, key in enumerate(keys)]
            expected = _score_every_label(query, labels)
            assert _best_label(query, labels) == expected, (query, labels)
            outcomes["none" if expected is None else "exact" if expected[0] else "near"] += 1
    assert all(count >= 20 for count in outcomes.values()), outcomes


def test_an_exact_row_scores_every_label_and_keeps_the_first_best():
    labels = [("Centre", "centre"), ("Carrefour Centre", "carrefour centre"),
              ("Carrefour Centre bis", "carrefour centre")]
    assert _best_label("carrefour centre", labels) == (True, "Carrefour Centre", 1.0)
    exact, label, score = _best_label("centre", [("Zzz", "zzz"), ("Centre", "centre")])
    assert (exact, label, score) == (True, "Centre", 1.0)
    assert _best_label("centre", [("Zzz", "zzz")]) is None
