# Phone test (DEV database only)

Goal: do real shop work on a phone and note anything awkward. Use made-up test data (for example customer "Test Customer").
Do this against DEV. Check first that `.env` `APP_DB_URL` is the DEV one, never production.

## Set up (PC and phone on the same home Wi-Fi)
1. Stop `npm run dev` (Ctrl+C). Open two terminals in the project folder:
   - Terminal 1: `npm run dev -w server`
   - Terminal 2: `npm run dev -w client -- --host`
2. Terminal 2 prints a line like `Network: http://192.168.1.23:5173/`. Type that address in the phone's browser.
3. If Windows asks about the firewall for Node.js, allow **Private networks** only.
4. If the page does not open: check both devices are on the same Wi-Fi (not a guest network) and try the address again.
Do not use public Wi-Fi for this: the dev site is not encrypted.

## Checklist
Mark each line OK or write what felt wrong (hard to tap, text too small, cut off, confusing message, slow).

| # | Do this on the phone | You should see | OK / what felt wrong |
|---|---|---|---|
| 1 | Log in | Home dashboard, no sideways scrolling | |
| 2 | Open the menu with one thumb; visit each section | Every section reachable, nothing hidden | |
| 3 | Inventory: search for a SKU | Matching rows, stock number readable | |
| 4 | Products: add a new variant (new colour/size) | Saved; appears in Inventory with stock 0 | |
| 5 | Purchases: create a PO for the new variant, receive it | Stock goes up by the received quantity | |
| 6 | Purchases: record a part-payment to the supplier | Balance drops, status Partial | |
| 7 | Customers: add "Test Customer" | Saved, gets the next CUST code | |
| 8 | Orders: new order, 2 lines, add an advance payment | Totals add up, shows Advance/Partial | |
| 9 | Orders: edit the order, remove an unshipped line | Line removed, total updates | |
| 10 | Shipping: try to ship more than the stock | Plain message such as "Not enough stock: only 1 left" (no database wording) | |
| 11 | Shipping: ship part of the order, then the rest as a second parcel | Two parcels, shipping charged per parcel, stock reduced only when shipped | |
| 12 | Courier month-end: settle the test parcels | Parcels marked paid to courier, amount due drops | |
| 13 | Orders: pay more than the total, then refund the overpayment | Refund works; asking for more than the surplus is refused in plain English | |
| 14 | Reports: scroll through tiles, charts and tables | Charts fit the screen; wide tables scroll sideways inside themselves | |
| 15 | Open a pop-up, type in a field with the keyboard open | Fields not hidden by the keyboard, Save/Cancel buttons still reachable | |
| 16 | Turn the phone sideways, then back | Layout still usable | |

## Also notice
- Anything you would not understand without help (words, buttons, order of steps)
- Anything slower than about 2 seconds
- Anything you had to zoom in to read or tap

Send Claude the list of problems (a screenshot is fine; hide any password or address bar with secrets). The test data
stays in the DEV database and is ignored later; production is not touched.
