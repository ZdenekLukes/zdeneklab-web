# LYRA / BUILD LOG — publikace průběžných ověřených výsledků

Veřejný záznam: https://zdeneklab.cz/lyra-progress.html
Publikační repo: ZdenekLukes/zdeneklab-web (main)
Stavový soubor: lyra-progress.json
Fotografie dílů: assets/lyra-progress/*.png
Původ dat: soukromý ZdenekLukes/AI_HEAD (Source of Truth).

## Každý checkpoint, cílově po 30 minutách

1. Ověř aktuální HEAD Mac mini, lokální změny i vzdálené commity. Neměň pracovní strom jen kvůli webu.
2. Aktualizuj updatedAt, source.sha, release a krátký seznam tasks. Hodnota done/total znamená skutečně DOKONČENÉ, ověřené kontrolní kroky. Nezvyšuj ji pouze proto, že uběhl čas nebo vznikl nový commit.
3. Do snapshots přidej reálné PNG pro P1, P2, PF, P3R, P4R, P5, P7, GL, GR. Publikuj jen snímky skutečné zdrojové geometrie s názvem dílu, stage a SHA. U starého obrázku zůstává jednoznačný štítek REFERENCE. Nikdy neoznačuj vizualizaci za hotový tisk.
4. Do history vlož krátký faktický záznam (nejnovější první) pro budoucí video; existující záznamy ponech.
5. Publikuj JSON a nové PNG do veřejného webového main. Ověř veřejnou adresu. Neposílej do webu interní technická data, kompletní soukromý BOM nebo nepovolené soubory.
6. Stránka načítá veřejný JSON při otevření a každých 30 minut. Změna údajů nastává AŽ po publikaci ověřeného checkpointu.

## Plánovaná půlhodinová kontrola

Lehký veřejný GitHub workflow lyra-progress-pulse.yml zaznamenává cca každých 30 minut poslední zveřejněný Mechanical Studio preview commit a čas kontroly v intervalu 28.10.2026 06:00–18:00 Europe/Prague. Workflow NEMÁ přístup k soukromému AI_HEAD a nikdy nezvýší stav konstrukčních prací bez dokladů.

## Printing Contract

PRINTING: Follow tools/mechanical_studio/PRINTING_CONTRACT.md
(AI_CUBE_PRINTING_CONTRACT_V1).
All automatic contract checks must pass.
Do not weaken, bypass or reclassify a failing check to make the design green.

Vizuální souhlas s POLISH neznamená automaticky schválení SKELETON, DETAIL, PRINT RELEASE ani sliceru.