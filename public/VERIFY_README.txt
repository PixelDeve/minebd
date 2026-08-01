Google Search Console verification (HTML file method)
====================================================
1. In Search Console, click DOWNLOAD the verification HTML file
   (do not use a file you typed yourself).
2. Replace public/google08bec25b7dda3f48.html with that exact downloaded file.
3. Deploy to Cloudflare Pages.
4. Open https://minebd.pages.dev/google08bec25b7dda3f48.html
   - You must see ONLY the verification text (one short line).
   - If you see the full MineBD website, the file is not deployed correctly.
5. Click Verify in Search Console.

OR use HTML tag method instead (often easier):
1. In Search Console choose "HTML tag"
2. Copy the content="...." token
3. Put it in index.html as:
   <meta name="google-site-verification" content="YOUR_TOKEN" />
4. Deploy and Verify.
