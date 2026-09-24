# Slop Machine

A doom-scroll feed of small, user-made web games where every swipe to the next game costs a small payment, like pulling a slot machine lever.

## Language

**Slop**:
A game published to Slop Machine by its Creator, which plays inline in the feed. A Slop keeps its identity when its Creator republishes it: it always plays its current Version. Affectionate, not pejorative.
_Avoid_: app, post, item

**Version**:
One published, unchangeable copy of a Slop's static web bundle. Publishing again makes a new Version and moves the Slop to it; old Versions can still be opened by their own link.
_Avoid_: build (the Creator's local output), release (suggests a review step)

**Creator**:
Someone who publishes Slop.
_Avoid_: developer, uploader, vibe coder (describes where Slop comes from, not a role)

**Player**:
Someone who scrolls the feed and plays Slop.
_Avoid_: user, viewer

**Pull**:
One paid swipe from the current Slop to the next. The Player pays a toll to the platform; the Creator gets none of it. The toll buys the platform's choice of which Slop comes next, not access to the Slop itself: every Slop stays public and free to open by its link.
_Avoid_: spin, scroll, swipe (the gesture, not the paid act)

**Purchase**:
A payment a Player makes from inside a Slop to that Slop's Creator, which the Player confirms each time.
_Avoid_: in-app purchase, IAP, tip, donation

**Feed**:
The sequence of Slop a Player pulls through. The platform picks each next Slop for that Player, favouring Slop they haven't seen yet.

**Takedown**:
The platform operator's act of blocking a Slop, a Version, or a Creator, so the Feed never deals it or opens it by link. It hides the Slop rather than deleting it, because Versions are permanent.
_Avoid_: removal, delete, unpublish (the Creator's own act)

**Runway**:
How much a Player can still spend on Pulls and Purchases before their money runs out, shown as a count of Pulls. A Player funds their own Runway from devnet faucets; the platform gives none.
_Avoid_: balance, credits, tokens

**Refill**:
A Player adding more Runway to their channel, with mock USDC they draw from the TOON faucet themselves.
_Avoid_: top-up, deposit (the on-chain mechanism, not the Player's act)

**Save**:
A Slop's progress for one Player, kept by the Feed on the Player's device. It belongs to the Slop, not to a Version, so it carries over when the Creator publishes again.
_Avoid_: save game, progress, state (the live game, which a Save only snapshots)

## Relationships

- A **Creator** publishes many **Slop**
- A **Slop** has many **Versions** and plays exactly one, its current Version
- Unpublishing a **Slop** takes it out of the **Feed**; its **Versions** can never be deleted
- A **Takedown** is made by the platform, unpublishing by the **Creator**; either takes a **Slop** out of the **Feed**
- A **Player** makes many **Pulls**; each **Pull** lands on exactly one **Slop**
- Each **Pull** pays only the platform
- A **Pull** buys the **Feed**'s next pick; any **Slop** can still be opened for free outside the **Feed**
- Each **Purchase** pays only the **Creator** of the **Slop** it was made in; the platform takes no cut, except a Purchase that was paid for but never reached the platform to be credited, which the platform keeps
- A **Slop** names where its **Creator** is paid; a Slop that names nowhere can't ask for a **Purchase**
- A **Creator** collects what their **Purchases** earned whenever they like; the platform never pays out on a schedule
- The platform and **Creators** compete for the **Player**: the platform earns when the Player pulls away, a Creator earns when the Player stays and makes Purchases
- A **Pull** lands once its payment has been taken, even if the next pick never comes back, and only on a **Slop** that has loaded; a Pull that wasn't paid for leaves the **Player** where they were
- A **Slop** that fails to load is replaced by another pick at no cost to the **Player**; a Slop that loads and then breaks is its **Creator**'s bad game, not a failure the platform answers for
- Each **Pull** and **Purchase** spends **Runway**; a **Refill** restores it
- A **Pull** or **Purchase** whose payment was taken counts as made: the **Player** is never told they weren't charged when they were, and when the **Feed** can't tell, it says so
- A **Slop** can only *ask* for a **Purchase**, and only right after the **Player** taps it; the **Feed** confirms it with the Player and pays
- A **Player** can go back through every **Slop** they pulled past for free; going back never costs a **Pull**
- A **Slop** has at most one **Save** per **Player** device, which only that Slop can read or write; a Slop opened outside the **Feed** keeps no Save across **Versions**
- A **Purchase** is remembered by the **Feed** apart from the **Save**, so a Slop can see what the **Player** bought even after its Save is gone

## Flagged ambiguities

- "tokens" in the original pitch meant the payment for a Pull; on TOON that is USDC (base units), not a platform token.
