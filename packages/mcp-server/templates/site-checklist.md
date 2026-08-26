# Sajtchecklista — definition of done

Kopieras in som `checklist.md` i varje sajtmapp av startkitet. Agenten
bockar av och håller den ärlig — en ruta bockas först när den är
verifierad (preview/livetest), inte när koden är skriven. Punkter som
medvetet inte gäller sajten stryks med motivering i build-log.

## Grund

- [ ] Site settings: namn, tagline, språk, kontakt
- [ ] Färger + typsnitt enligt grafisk profil (`update_site_settings`)
- [ ] Logotyp uppladdad som media, satt i `settings.logo` OCH använd i headern
- [ ] Favicon (`settings.favicon`) + apple touch icon (`settings.apple_touch_icon`)
- [ ] Header-partial: nav + ev. CTA, mobilrobust
- [ ] Footer-partial: kontakt, ev. organisationsinfo

## Innehåll

- [ ] Alla sidor enligt brief; godkänd copy används ordagrant
- [ ] Bildsättning enligt stilprofilen (`prompts/image-style.md`) — inga textöknar
- [ ] Alla bilder har riktig `alt`-text (rätt språk)
- [ ] Formulär skapade + embeddade med `_token` från `read_form`
- [ ] Interna länkar fungerar (nav, knappar, fotlänkar)

## SEO

- [ ] Sidtitel + meta description per sida
- [ ] `default_seo_suffix` satt; `default_meta_description` som fallback
- [ ] OG-bild (`default_og_image`) så delningar får ett kort
- [ ] Organisation i settings (`organization.name/logo/same_as`) för JSON-LD
- [ ] Slugs genomtänkta; redirects skapade för varje slug-ändring
- [ ] `language` rätt satt (styr `<html lang>`)

## Kvalitet

- [ ] Preview granskad på mobil + desktop (alla sektioner, menyn)
- [ ] Rubrikhierarki: exakt en h1 per sida, logisk nivåföljd
- [ ] Kontraster ok mot bakgrunderna (profilens palett ≠ automatiskt läsbar)
- [ ] Stora bilder har varianter (`generate_image_variants`) + rimlig `sizes`
- [ ] Block-läge: blockluckor journalförda i build-log ("Blockluckor")

## Lansering

- [ ] Deploy till fallback-URL, godkänd av användaren
- [ ] Formulär livetestat efter deploy (inskick + bekräftelsesida + inbox)
- [ ] Favicon/touch-icon syns på den deployade sajten
- [ ] Domän deklarerad i portalen (canonical bakas in) — DNS pekas SIST
- [ ] Efter DNS: båda hostname-varianterna verifierade (apex + www)

## Löpande

- [ ] `build-log.md` uppdaterad efter varje pass (beslut, friktion, länkar)
- [ ] Den här listan uppdaterad — obockade rutor är aktiv att-göra-lista
