---
name: omni-tokens
description: Pay for your own inference with on-chain tokens. Use when an agent needs an OpenRouter key funded from a crypto wallet, needs to check how much a tab key has left, or needs to close a tab and get unused tokens back.
---

# omni-tokens

A tab server turns locked ERC-20 tokens into a normal OpenRouter API key with a USD cap. Unused tokens go back to the wallet when the tab closes. The key works anywhere OpenRouter does: base URL `https://openrouter.ai/api/v1`, any OpenAI-compatible client.

There are two ways to use this skill. Pick the one that matches what the user gave you.

## 1. The user gave you a tab key

Treat it like any OpenRouter key. Read it from the environment (`OPENROUTER_API_KEY`) or the host's secret store; never ask for it in chat, and never print, log or commit it.

Check what is left before a batch of work, without spending anything:

```sh
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

`data.limit_remaining` is in USD. Zero means the tab is spent; the key stops working and the server closes the tab on its own. A 401 or 403 means the tab was closed.

## 2. You hold a wallet and the user approved a budget

Use the CLI at `cli/tab.ts` in the omni-tokens repo (run `npm install` there first). It needs Node 22.18+ and these variables:

| Variable | What |
| --- | --- |
| `TAB_SERVER` | The tab server's URL |
| `RPC_URL` | An RPC endpoint for the server's chain |
| `PRIVATE_KEY` | The wallet that pays. Only ever from the environment. |

```sh
node cli/tab.ts tokens                 # what the server accepts, with prices
node cli/tab.ts quote USDC 10          # what 10 USDC buys, in USD of inference
node cli/tab.ts open USDC 10 --json    # lock, claim, print { key, tab }
node cli/tab.ts status                 # every tab this wallet opened
node cli/tab.ts close <tabId>          # stop the key, refund the rest
```

Rules:

- **Stay inside the budget.** Quote first. Open a tab only for an amount the user approved, in the token they approved. A tab's lock is the most it can ever cost.
- **The key prints once.** Put it straight into the environment or secret store your harness uses for OpenRouter. If it is lost, close the tab and open a new one; nothing can show it again.
- **Close when done.** `close` stops the key and returns everything unspent once usage settles (a couple of minutes). Do not leave tabs open "just in case".
- **`release` is the emergency exit.** It works only after the close timeout shown by `tokens`, and only if the server never settled. Do not use it on a healthy server: usage the server has not charged yet is lost to the operator.
- **Never** ask for, accept or move a wallet's seed phrase, and never send tokens anywhere except through these commands.

## When something fails

| Error | Meaning |
| --- | --- |
| `tab_too_small` | Below the server's minimum. Close the tab to get the tokens back. |
| `out_of_credit` | The operator's OpenRouter balance is low. Try later, or close the tab. |
| `price_unavailable` | The server could not price the token safely. Try later, or close the tab. |
| `unknown_token` | The server does not price that token. Close the tab. |
| `already_claimed` | The key was issued before. Close and reopen if it is lost. |
