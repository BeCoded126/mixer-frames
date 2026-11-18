# Mixer attendee frame

Profile-picture maker for the Bi-Annual Child & Adolescent Mixer (Dec 3, Fort Lauderdale Behavioral Health Center).

- `index.html` + `attend-frame.png`: the page, served by GitHub Pages.
- `supabase/functions/age10`: the Supabase Edge Function that makes the age-10 portrait with OpenAI. The OpenAI key lives only in Supabase secrets.
- `sign/`: "Sign My Yearbook" page. People write a note in a 5:3 box; it saves a transparent 1800x1080 PNG (`note-firstname-lastname.png`) to the private `yearbook-notes` bucket and a row in `yearbook_notes`.
- `sign/admin/`: passcode-protected page to preview the notes and download them all as a zip.
- `supabase/functions/yearbook`: the Edge Function behind both pages.
