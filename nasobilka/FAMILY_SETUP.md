# Rodinný žebříček – nasobilka

Rodinná verze je připojená k Supabase projektu `zdeneklab-family`.

## Architektura

- GitHub Pages: `zdeneklab.cz/nasobilka/`
- Supabase: společná databáze výsledků
- tabulka: `public.math_scores`
- RLS: veřejné čtení a zápis pouze pro interní family_id této hry
- anonymní návštěvník nemá UPDATE ani DELETE oprávnění

## Soutěžní pravidla

Do rodinného žebříčku se zapisuje pouze 60sekundová výzva, aby byly výsledky srovnatelné.

- 1. správná odpověď v sérii: +10
- 2.: +12
- 3.: +14
- 4.: +16
- 5.: +18
- 6. a další: +20
- chyba: −3 a série se vynuluje
- skóre neklesne pod 0
- TOP 10 zobrazuje nejlepší výkon každého jména
- zobrazuje se správně/celkem a úspěšnost

Režimy 10 a 20 příkladů jsou tréninkové a do rodinného žebříčku se nezapisují.

## Bezpečnostní poznámka

V HTML je pouze Supabase publishable key, který je určen pro klientské aplikace. Secret/service_role key nesmí být v repozitáři.
