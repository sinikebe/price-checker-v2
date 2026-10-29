"""Conservative, offline-only defaults for the catalogue navigation hierarchy.

Local product tags are the primary hint.  A small group-name fallback covers
legacy records without tags.  Neither source changes the comparable group.
"""
from __future__ import annotations

UNCATEGORIZED = "À classer"

# Exact, curated local tags. Order is meaningful when a group has several tags.
TAG_HINTS: dict[str, tuple[str, str]] = {
    "chips": ("Épicerie salée", "Chips"),
    "lave-vaisselle": ("Entretien", "Lave-vaisselle"),
    "tablettes lave-vaisselle": ("Entretien", "Lave-vaisselle"),
    "capsules lave-vaisselle": ("Entretien", "Lave-vaisselle"),
    "gel lave-vaisselle": ("Entretien", "Lave-vaisselle"),
    "nettoyant lave-vaisselle": ("Entretien", "Lave-vaisselle"),
    "liquide de rinçage": ("Entretien", "Lave-vaisselle"),
    "sel régénérant": ("Entretien", "Lave-vaisselle"),
    "liquide vaisselle": ("Entretien", "Vaisselle à la main"),
    "papier toilette": ("Hygiène", "Papier toilette"),
    "gel douche": ("Hygiène", "Gels douche et savons"),
    "soda": ("Boissons", "Sodas"),
    "cola": ("Boissons", "Sodas"),
    "jus d'orange": ("Boissons", "Jus de fruits"),
    "jus de pomme": ("Boissons", "Jus de fruits"),
    "jus d'ananas": ("Boissons", "Jus de fruits"),
    "pur jus": ("Boissons", "Jus de fruits"),
    "brioche": ("Boulangerie", "Brioches"),
    "céréales": ("Petit-déjeuner", "Céréales"),
    "cruesli": ("Petit-déjeuner", "Céréales"),
    "biscuit": ("Épicerie sucrée", "Biscuits"),
    "chewing-gum": ("Épicerie sucrée", "Confiseries"),
    "cône glacé": ("Surgelés", "Glaces"),
    "crème dessert": ("Crèmerie", "Desserts lactés"),
    "fromage": ("Crèmerie", "Fromages"),
    "fromage fondu": ("Crèmerie", "Fromages"),
    "lait": ("Crèmerie", "Laits"),
    "yaourt": ("Crèmerie", "Yaourts"),
    "oeufs": ("Crèmerie", "Œufs"),
    "salade": ("Fruits et légumes", "Salades et jeunes pousses"),
    "épinard": ("Fruits et légumes", "Salades et jeunes pousses"),
    "germes de soja": ("Fruits et légumes", "Pousses et germes"),
    "haricots rouges": ("Épicerie salée", "Légumes en conserve"),
    "concentré de tomates": ("Épicerie salée", "Concentrés de tomates"),
    "couscous": ("Épicerie salée", "Semoules et couscous"),
    "mayonnaise": ("Épicerie salée", "Mayonnaises"),
    "moutarde": ("Épicerie salée", "Moutardes"),
    "jambon": ("Viandes et charcuterie", "Jambons"),
    "viande hachée": ("Viandes et charcuterie", "Viandes hachées"),
    "viande": ("Viandes et charcuterie", "Viandes hachées"),
    "merguez": ("Viandes et charcuterie", "Saucisses et merguez"),
    "carotte": ("Fruits et légumes", "Carottes"),
    "pâtes": ("Épicerie salée", "Pâtes"),
    "crème liquide": ("Crèmerie", "Crèmes"),
    "crème fraîche": ("Crèmerie", "Crèmes"),
    "haché aux oignons": ("Viandes et charcuterie", "Viandes hachées"),
    "steak haché": ("Viandes et charcuterie", "Viandes hachées"),
    "lentilles": ("Épicerie salée", "Légumes en conserve"),
    "maïs": ("Épicerie salée", "Légumes en conserve"),
    "raisins secs": ("Épicerie sucrée", "Fruits secs"),
    "riz": ("Épicerie salée", "Riz"),
    "sac de courses": ("Maison", "Sacs de courses"),
    "thon": ("Épicerie salée", "Poissons en conserve"),
    "vermicelles de soja": ("Épicerie salée", "Nouilles et vermicelles"),
}

GROUP_HINTS: dict[str, tuple[str, str]] = {
    "8 barquitas au blé nature": ("Épicerie salée", "Tortillas et pains à garnir"),
    "camembert 8 portions lp (8x30g=240g": ("Crèmerie", "Fromages"),
    "jambon paris ac 10t": ("Viandes et charcuterie", "Jambons"),
    "moutard de dijon": ("Épicerie salée", "Moutardes"),
    "sauce caesar au parmesan": ("Épicerie salée", "Sauces pour salade"),
    "cruesli chocolat au lait": ("Petit-déjeuner", "Céréales"),
    "cruesli chocolat noir": ("Petit-déjeuner", "Céréales"),
    "la vache qui rit": ("Crèmerie", "Fromages"),
}


def default_classification(group: str, tags: list[str]) -> tuple[str, str, str]:
    """Return department, family and evidence; never guess an unknown family."""
    known_tags = {tag.strip().casefold() for tag in tags if isinstance(tag, str)}
    for tag, location in TAG_HINTS.items():
        if tag in known_tags:
            return *location, "local_tag"
    location = GROUP_HINTS.get(group.strip().casefold())
    if location:
        return *location, "group_name"
    return UNCATEGORIZED, UNCATEGORIZED, "unclassified"


# Optional broader price-comparison sets. Keep this deliberately curated:
# a family is a browsing shelf, not necessarily a meaningful price comparison.
COMPARISON_HINTS: dict[tuple[str, str], str] = {
    ("Jus de fruits", "pur jus d'orange"): "Jus d'orange",
    ("Jus de fruits", "pur jus d'orange avec pulpe"): "Jus d'orange",
    ("Jus de fruits", "pur jus d'orange sans pulpe"): "Jus d'orange",
    ("Jus de fruits", "pur jus de pomme"): "Jus de pomme",
    ("Jus de fruits", "pur jus de pomme bio"): "Jus de pomme",
    ("Moutardes", "moutard de dijon"): "Moutarde de Dijon",
    ("Moutardes", "moutarde de dijon forte en bocal"): "Moutarde de Dijon",
    ("Riz", "riz basmati"): "Riz basmati",
    ("Riz", "riz basmati prêt en 11 min"): "Riz basmati",
}


def default_comparison_scope(group: str, family: str) -> str | None:
    """Seed only clear optional sets; an admin can add or remove one later."""
    return COMPARISON_HINTS.get((family, group.strip().casefold()))
