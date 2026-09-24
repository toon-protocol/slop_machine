# Slop Machine

A doom-scroll feed of small, user-made web games where every swipe to the next game costs a small payment, like pulling a slot machine lever.

## Language

**Slop**:
A game published to Slop Machine: a self-contained static web bundle that plays inline in the feed. Affectionate, not pejorative.
_Avoid_: app, post, item

**Creator**:
Someone who publishes Slop.
_Avoid_: developer, uploader, vibe coder (describes where Slop comes from, not a role)

**Player**:
Someone who scrolls the feed and plays Slop.
_Avoid_: user, viewer

**Pull**:
One paid swipe from the current Slop to the next. The Player pays a toll to the platform; the Creator gets none of it.
_Avoid_: spin, scroll, swipe (the gesture, not the paid act)

**Purchase**:
A payment a Player makes from inside a Slop to that Slop's Creator, which the Player confirms each time.
_Avoid_: in-app purchase, IAP, tip, donation

**Feed**:
The ordered sequence of Slop a Player pulls through.

**Runway**:
How much a Player can still spend on Pulls and Purchases before their money runs out, shown as a count of Pulls. A new Player starts with Runway the platform gives them.
_Avoid_: balance, credits, tokens

**Refill**:
A Player's request for more Runway, granted by the platform and limited in how often it can happen.
_Avoid_: top-up, deposit (the on-chain mechanism, not the Player's act)

## Relationships

- A **Creator** publishes many **Slop**
- A **Player** makes many **Pulls**; each **Pull** lands on exactly one **Slop**
- Each **Pull** pays only the platform
- Each **Purchase** pays only the **Creator** of the **Slop** it was made in; the platform takes no cut
- The platform and **Creators** compete for the **Player**: the platform earns when the Player pulls away, a Creator earns when the Player stays and makes Purchases
- A **Pull** lands only once its payment has cleared; an uncleared Pull leaves the **Player** where they were
- Each **Pull** and **Purchase** spends **Runway**; a **Refill** restores it

## Flagged ambiguities

- "tokens" in the original pitch meant the payment for a Pull; on TOON that is USDC (base units), not a platform token.
