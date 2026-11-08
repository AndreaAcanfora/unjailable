# Security

## The contract

`contracts/src/AgentVault.sol` is the part that holds money. If you find a way for anyone
other than the owner to move more than the policy allows (more than `perPaymentCap` in one
payment, more than `periodCap` in one window, anything after expiry or while paused, or to
a recipient that is not allowed), please report it.

For the live challenge vault, such a bug is the prize: the challenge is an open invitation
to break the contract, and what you can take through a genuine contract bug is yours to
keep. We would still be grateful if you wrote it up afterwards so everyone can learn.

For anything else (the MCP server, the challenge server, or a vault someone else deployed),
please report privately through GitHub's "Report a vulnerability" on this repository
instead of opening a public issue.

## Out of scope

- Jailbreaking Warden. That is the game, not a vulnerability. Payments within the caps are
  the expected outcome of a successful jailbreak.
- Spending the challenge's daily model budget or hitting its rate limits.
- Anything that needs the owner's key.
