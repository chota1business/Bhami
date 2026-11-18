# Saree & Dress Management

A static React app for internal supplier, purchasing, materials, production, inventory and sales records. Supabase handles email-link sign-in, business membership, private files and atomic stock posting.

## Local preview

Serve this directory over HTTP and open its root URL. For example, run `python -m http.server 8765 --bind 127.0.0.1` from this directory. The app loads version-pinned React and Supabase modules from esm.sh. The key in `config.mjs` is the browser publishable key. Business data and private files stay in Supabase.

## GitHub Pages

Create a dedicated repository and commit the contents of this directory at the root, including `.nojekyll`. Under Settings → Pages, select Deploy from a branch and publish from the root of `main`. GitHub Free requires a public source repository for Pages.

After Pages reports the actual HTTPS project URL, set that exact URL with a trailing slash as the Supabase Auth Site URL and add it to the redirect allow list. Keep app invites and magic links pointed at that URL. Supabase's default email sender has delivery and rate limits. Check email delivery to the owner before onboarding other roles.

## Workflow

1. Add suppliers and purchases. Add each fabric or lace lot with its received quantity and cost per unit, and link it to an optional purchase.
2. Add a product. Receive finished stock or complete production from one or more material lots. The batch records material, tailoring and other costs.
3. Record an already-fulfilled sale. The database checks available stock and applies all deductions together.
4. Upload photos or purchase documents under Files and link each to its record.

Owners and partners have operational access. Staff can view their business and their own membership. Create Auth users and assign memberships in Supabase during this first release. The app does not collect payments.
