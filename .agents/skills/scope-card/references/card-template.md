# Scoping section: layout, writing rules and Notion skeleton

Syntax: Notion enhanced markdown (`notion://docs/enhanced-markdown-spec`). Indent **with tabs**: a child that is not indented falls out of its toggle or callout. Outside code, escape `\ * ~ ` $ [ ] < > { } | ^` with a backslash (in text, not in tags).

The skeleton's labels are in French because the kanban is; use the card's language.

## Layout

Goal: the verdict reads in ten seconds, details are folded, and the section reads well on Notion desktop and on the iOS app.

| Need | Block | Rule |
|---|---|---|
| Open the section | `---` then `## Scoping` | separates the section from the card's description |
| Metadata | one line: type pill, surface pills, then size · process weight · date · SHA | type: `purple_bg` (feature UX), `blue_bg` (feature), `red_bg` (bug); surfaces `gray_bg` |
| Verdict | `<callout icon="🎯" color="blue_bg">` | first block, 2-3 bullets in plain language (see Writing rules) |
| To decide | `<callout icon="❓" color="yellow_bg">` + to-dos | absent when there is nothing to decide |
| Solutions (every type) | `### 💡 Solutions`, **not folded**, right after À trancher: a table Option · Ce que ça change pour toi · Ampleur · Risque (bug, feature) or tabs A/B/C (feature UX), then a ⭐ Reco callout | required; 2-3 distinct options (one only for a bug with a single path, saying so) |
| Details | toggle heading `### … {toggle="true"}` | closed by default; fixed emoji: 📐 Cadrage · 🧱 Existant Rakazo · 🌍 Ailleurs · 🐞 Diagnostic · 🎨 Design · ⚠️ Risques et découpage |
| Comparisons | `<table header-row="true" fit-page-width="true">` | rich text only in cells; `retenu` in `green_bg`, `écarté` in `gray_bg`; "rien de comparable" in `gray` |
| Acceptance criteria | to-do `- [ ]` | reused as the QA checklist |
| Root cause | `<callout icon="🔎" color="red_bg">` | |
| Three proposals | `<tabs>`, one `<tab>` per proposal | fallback: three `<details>` toggles when tabs render badly on iOS |
| Recommendation | `<callout icon="⭐" color="green_bg">` + Claude Design link | |
| Complementary sources | `<callout icon="🧭" color="gray_bg">` | one line |
| Langfuse measurement | `<callout icon="📈" color="gray_bg">` in 🧱 Existant (or 🐞 Diagnostic for a bug) | aggregate figures and trace links, never conversation excerpts; labelled with the instance it was measured on |
| Links | `[path:line](https://github.com/…/blob/<SHA>/path#Lnn)`, `<mention-page>`, `<mention-user>` | never a raw URL in view |

Restraint: colour carries meaning (blue verdict, yellow decision, green recommendation or kept, red only for root cause or security risk, grey for the rest). No columns, no `<empty-block/>`, no walls of text: one idea per bullet or cell. Under 60 visible lines with toggles closed.

## Writing rules (the top of the card is read by the person deciding, who may not be a developer)

The verdict and À trancher must read **without opening a single toggle and without knowing the code**. Technical detail lives in the toggles.

- **Say what the user experiences, then what we propose.** The verdict is 2 or 3 short bullets: "Aujourd'hui" or "Ce qui se passe", then "Ce qu'on propose" (or "Étape 1 / Étape 2"). Never a paragraph.
- **One idea per sentence**, short sentences, action verbs, a clear subject ("le bot", "l'app", "tu").
- **No jargon at the top of the card**: no proxy, 502, run, prompt, sentinel, SHA, executor, viewer, trigger, "coded decision". When the concept is needed, say it in everyday words ("la connexion entre l'app et l'écran du bot", "c'est le code, plus le bot, qui décide").
- **No document or source name without context** ("as the OST recommended"): say what it recommended, or keep it for the 🌍 Ailleurs toggle.
- **Useful numbers only**, in meaningful units ("0,3 seconde", "1 message sur 7"), no milliseconds or cascades of percentages.
- **One question = one choice**, asked the way you would say it out loud, with the stake in one sentence when needed. No parentheses of technical explanation.
- **Final test**: re-read the verdict as if you knew neither the code nor the conversation. Rewrite any sentence that needs explaining.

Real counter-example (do not reproduce):
> Le moteur sait déjà se taire (une routine sans texte ne poste rien et ne notifie pas), mais rien ne dit au bot qu'il en a le droit […] Étape 2, comme le recommandait l'OST proactivité : le silence et le niveau d'importance deviennent une décision codée, filtrée à un seul endroit, plutôt qu'une règle en prose.

Same content, readable:
> - **Aujourd'hui** : quand une routine ne trouve rien, le bot t'envoie quand même un message pour le dire. Il pourrait ne rien envoyer, mais personne ne lui a dit qu'il en avait le droit.
> - **Étape 1** : on dit clairement au bot de se taire quand il n'a rien d'utile, et seul un message envoyé exprès arrive chez toi.
> - **Étape 2, si besoin** : c'est le code, et plus le bot, qui décide si un message mérite une notification.

In the toggles, technical vocabulary is fine (it is the spec draft), but every cell stays a complete, understandable sentence, and every claim carries its evidence (a permalink, a trace, a command output) or its label: *mesuré*, *déduit* or *supposé*.

## Full skeleton (feature UX)

Remove the blocks that do not apply to the type (see Variants). Replace every `<…>`.

```
---
## Scoping
<span color="purple_bg">feature UX</span> <span color="gray_bg">web</span> <span color="gray_bg">iOS</span> · ampleur moyenne · poids « Changement d'UI visible » · <mention-date start="2026-10-04"/> · `a1b2c3d`
<callout icon="🎯" color="blue_bg">
	**Verdict**
	- **Aujourd'hui** : <ce que vit l'utilisateur, en mots simples>
	- **Ce qu'on propose** : <la solution, en mots simples ; ou deux puces Étape 1 / Étape 2>
</callout>
<callout icon="❓" color="yellow_bg">
	**À trancher**
	- [ ] <question 1>
	- [ ] <question 2>
</callout>
### 💡 Solutions
<tabs>
	<tab icon="🅰️">
		A · <nom court>
		**Principe** — <…>
		**Ce qu'on retire** — <…>
		**Ampleur** — <PR, surfaces, ce que tu devras valider> · **Risque** — <…>
	</tab>
	<tab icon="🅱️">
		B · <nom court>
		**Principe** — <…>
		**Ce qu'on retire** — <…>
		**Ampleur** — <PR, surfaces, ce que tu devras valider> · **Risque** — <…>
	</tab>
	<tab icon="🆎">
		C · <nom court>
		**Principe** — <…>
		**Ce qu'on retire** — <…>
		**Ampleur** — <PR, surfaces, ce que tu devras valider> · **Risque** — <…>
	</tab>
</tabs>
<callout icon="⭐" color="green_bg">
	**Reco : <lettre> · <nom>** — <pourquoi, en 1-2 phrases>. [Ouvrir les maquettes](<url du canvas Claude Design>)
</callout>
### 📐 Cadrage {toggle="true"}
	**Problème** — <reformulation côté utilisateur>
	**Users** — <qui est concerné>
	<table header-row="true" fit-page-width="true">
		<tr>
			<td>Dans le scope</td>
			<td>Hors scope</td>
		</tr>
		<tr>
			<td><…></td>
			<td><span color="gray"><…></span></td>
		</tr>
	</table>
	**Critères d'acceptation**
	- [ ] <critère observable 1>
	- [ ] <critère observable 2>
	<table header-row="true" fit-page-width="true">
		<tr>
			<td>Cas</td>
			<td>Comportement attendu</td>
		</tr>
		<tr>
			<td>Vide</td>
			<td><…></td>
		</tr>
		<tr>
			<td>Chargement</td>
			<td><…></td>
		</tr>
		<tr>
			<td>Erreur</td>
			<td><…></td>
		</tr>
		<tr>
			<td>Concurrence</td>
			<td><…></td>
		</tr>
	</table>
	**i18n** — <impact ou « aucun »>
### 🧱 Existant Rakazo {toggle="true"}
	<table header-row="true" fit-page-width="true">
		<tr>
			<td>Surface</td>
			<td>Comportement actuel</td>
			<td>Fichiers</td>
		</tr>
		<tr>
			<td>Web</td>
			<td><…></td>
			<td>[apps/web/…:42](https://github.com/<owner>/<repo>/blob/<SHA>/apps/web/…#L42)</td>
		</tr>
	</table>
	**Primitives réutilisables** — <composants, contrats>
	<callout icon="📈" color="gray_bg">
		**Langfuse (7 j, <n> runs)** — <critère> : <chiffre clé> · <2e chiffre> · exemples : [trace](<url>), [trace](<url>)
	</callout>
### 🌍 Ailleurs {toggle="true"}
	<table header-row="true" fit-page-width="true">
		<tr>
			<td>Source</td>
			<td>Ce qu'ils font</td>
			<td>Pour nous</td>
		</tr>
		<tr>
			<td><dépôt de référence></td>
			<td><…> ([preuve](https://github.com/<owner>/<repo>/blob/<SHA>/…#Lnn))</td>
			<td><span color="green_bg">retenu</span> <pourquoi></td>
		</tr>
		<tr>
			<td>OpenClaw</td>
			<td><span color="gray">Rien de comparable</span></td>
			<td></td>
		</tr>
		<tr>
			<td>Hermes</td>
			<td><…></td>
			<td><span color="gray_bg">écarté</span> <pourquoi></td>
		</tr>
		<tr>
			<td>Meta Muse</td>
			<td><…> ([source](<url>), <date>)</td>
			<td><…></td>
		</tr>
		<tr>
			<td>ChatGPT Dots</td>
			<td><…> ([source](<url>), <date>)</td>
			<td><…></td>
		</tr>
		<tr>
			<td>Bench des primitives</td>
			<td>§<x.y> <primitive></td>
			<td><…></td>
		</tr>
	</table>
	<callout icon="🧭" color="gray_bg">
		**Sources complémentaires** — <consultées et apport> ou « aucune, parce que <…> »
	</callout>
### 🎨 Design {toggle="true"}
	**Benchmark Mobbin**
	<table header-row="true" fit-page-width="true">
		<tr>
			<td>App</td>
			<td>Pattern</td>
			<td>Pour nous</td>
		</tr>
		<tr>
			<td>[<App>](<mobbin_url>) · iOS</td>
			<td><…></td>
			<td><span color="green_bg">retenu</span> <pourquoi></td>
		</tr>
	</table>
### ⚠️ Risques et découpage {toggle="true"}
	- <span color="red">Sécurité</span> — <risque> → revue sécurité obligatoire
	- **Parité** — <…>
	- **Provider-neutral** — <…>
	**Découpage**
	1. <PR 1> · <ampleur>
	2. <PR 2> · <ampleur>
---
### 🖼 Maquettes
<suggested_markdown de l'upload PNG>
<suggested_markdown de l'upload HTML>
### 💬 Réponses de <prénom de l'assigné>
<callout icon="💬" color="gray_bg">
	<mention-user url="user://<id Notion de l'assigné>"/> réponds ici ; cette zone n'est jamais réécrite.
</callout>
```

In this feature UX skeleton, the 🎨 Design toggle keeps the Mobbin benchmark and the canvas link; the tabs and the recommendation sit in 💡 Solutions. The zone rewritten on every rerun runs from the first `---` to the last line of the "Risques et découpage" toggle. The second `---`, Maquettes and Réponses are never in `old_str`.

## Variants

- **feature and bug: 💡 Solutions as a table** instead of tabs, full sentences in plain language:
  ```
  ### 💡 Solutions
  <table header-row="true" fit-page-width="true">
  	<tr>
  		<td>Option</td>
  		<td>Ce que ça change pour toi</td>
  		<td>Ampleur</td>
  		<td>Risque</td>
  	</tr>
  	<tr>
  		<td>**A · <nom court>**</td>
  		<td><ce qui change concrètement, en mots simples></td>
  		<td><nombre de PR · surfaces · revue sécurité ? · ce que tu devras valider ou tester></td>
  		<td><le risque principal, en une phrase></td>
  	</tr>
  </table>
  <callout icon="⭐" color="green_bg">
  	**Reco : <lettre(s)>** — <pourquoi, en 1-2 phrases>
  </callout>
  ```
- **feature**: no Mobbin table, no tabs. The 🎨 Design toggle holds only the link to the recommendation's mockup when UI is touched; otherwise no Design toggle and no Maquettes zone. Pill `blue_bg`.
- **bug**: Solutions as a table (1 to 3 fixes). No 🎨 Design, no Maquettes. A 🐞 Diagnostic toggle instead, before ⚠️:
  ```
  ### 🐞 Diagnostic {toggle="true"}
  	**Repro**
  	1. <étape>
  	2. <étape>
  	<callout icon="🔎" color="red_bg">
  		**Cause racine** — <explication> ([preuve](<permalien>))
  	</callout>
  	**Régression** — <commit ou « non »>
  	**Test qui échoue aujourd'hui**
  	```ts
  	<esquisse du test>
  	```
  ```
  « 🌍 Ailleurs » shrinks to the bench when relevant (often absent). Pill `red_bg`.
- **Duplicate or already in progress**: only the opening, the metadata line and
  ```
  <callout icon="🔁" color="gray_bg">
  	**Déjà couvert** — doublon de <mention-page url="<url>"/> · ou en cours dans [PR #<n>](<url>)
  </callout>
  ```
- **Tabs render badly on Notion iOS**: replace `<tabs>` with three `<details><summary>A · nom</summary>…</details>` at the same indentation.
