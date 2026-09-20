# Rodinný žebříček – nasobilka

Stav: frontend a databázové schéma jsou připravené na větvi `feature/family-leaderboard`.

## Co zbývá před sloučením do main

1. V Supabase vytvořit nebo vybrat projekt.
2. Spustit `nasobilka/supabase_setup.sql`.
3. V `nasobilka/index.html` nahradit:
   - `__SUPABASE_URL__` za Project URL
   - `__SUPABASE_PUBLISHABLE_KEY__` za publishable key (`sb_publishable_...`)
4. Otestovat zápis a čtení skóre.
5. Sloučit větev do `main`.

Nepoužívat secret key v HTML. Pro browser patří pouze publishable key.

## Soutěžní pravidla

Rodinný žebříček používá pouze 60sekundovou výzvu, aby byly výsledky srovnatelné.

- správná odpověď: +10 bodů
- série správných odpovědí: +2 za každý další krok série, maximálně +10 bonus
- chyba: -3 body a série se vynuluje
- skóre neklesne pod 0
- žebříček zobrazuje nejlepší výsledek každého hráče
- zobrazuje také správně/celkem a úspěšnost

Režimy 10 a 20 příkladů zůstávají tréninkové a do rodinného žebříčku se nezapisují.
