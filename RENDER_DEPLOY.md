# Deploy to Render in 5 Minutes

## Step 1: Create GitHub Repo (2 min)

1. Go to https://github.com/new
2. Name: `planning-center-mcp`
3. Choose **Public** (required for free Render)
4. Click **Create repository**

## Step 2: Push Code to GitHub (1 min)

In Terminal, in the `pco-mcp-server` folder:

```bash
git init
git add .
git commit -m "Planning Center MCP server"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/planning-center-mcp.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

## Step 3: Deploy on Render (1 min)

1. Go to https://render.com
2. Click **Sign up** → **Continue with GitHub**
3. Once logged in, click **New +** → **Web Service**
4. Select your `planning-center-mcp` repo
5. Fill in:
   - **Name**: `planning-center-mcp`
   - **Environment**: `Docker`
   - **Plan**: `Free`
6. Click **Create Web Service**

## Step 4: Add Credentials (1 min)

In the Render dashboard for your service:

1. Click **Environment** (left sidebar)
2. Click **Add Environment Variable**
3. Add first variable:
   ```
   Key: PCO_CLIENT_ID
   Value: [paste your client ID]
   ```
4. Click **Add Variable** again:
   ```
   Key: PCO_CLIENT_SECRET
   Value: [paste your client secret]
   ```
5. Click **Save Changes**

The service will rebuild automatically (2-3 minutes).

## Step 5: Verify It Works

1. Click **Logs** (left sidebar)
2. Wait for deployment to complete
3. You should see: `✓ Connected to Planning Center. Found groups.`
4. Copy your service **URL** - it looks like:
   ```
   https://planning-center-mcp.onrender.com
   ```

## Done! 🎉

Your MCP server is now running. Tell me the URL and I'll connect it to Claude to create the groups.

---

## If Something Goes Wrong

**Build failed?**
- Check the Logs tab for error messages
- Make sure you're in a public GitHub repo

**Connection failed?**
- Verify Client ID and Secret are correct
- Make sure you copied the full values (no extra spaces)

**Still stuck?**
- Render free tier can have brief restarts - wait 5 minutes
- Check that GitHub repo has all files: package.json, src/index.ts, Dockerfile, tsconfig.json
