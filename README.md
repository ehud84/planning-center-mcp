# Planning Center MCP Server

A Model Context Protocol (MCP) server that integrates with the Planning Center Online API, enabling Claude to manage groups and members directly.

## Features

- **List Groups**: View all groups in your Planning Center organization
- **Create Groups**: Create new groups with custom settings
- **Manage Members**: Add or remove people from groups
- **Search People**: Find people by name in your organization
- **Group Types**: Access available group types
- **View Memberships**: See all members and their roles in a group

## Setup & Deployment on Render

### Prerequisites

1. **GitHub Account** - For version control
2. **Render Account** - For hosting (free tier)
3. **Planning Center API Credentials**:
   - Client ID
   - Client Secret

### Step 1: Create a GitHub Repository

1. Go to https://github.com/new
2. Name it: `planning-center-mcp`
3. Choose "Public" or "Private"
4. Click **Create repository**

### Step 2: Push Code to GitHub

From your computer (in the project directory):

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/planning-center-mcp.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

### Step 3: Deploy to Render

1. Go to https://render.com
2. Sign up with GitHub (recommended)
3. Click **New +** → **Web Service**
4. Select your `planning-center-mcp` repository
5. Fill in the details:

   | Field | Value |
   |-------|-------|
   | **Name** | `planning-center-mcp` |
   | **Environment** | `Docker` |
   | **Region** | `Oregon` (or closest to you) |
   | **Branch** | `main` |
   | **Plan** | `Free` |

6. Click **Create Web Service**

### Step 4: Add Environment Variables

After the service is created:

1. Go to **Environment** (in left sidebar)
2. Click **Add Environment Variable**
3. Add these two variables:

   ```
   PCO_CLIENT_ID = [your_client_id]
   PCO_CLIENT_SECRET = [your_client_secret]
   ```

4. Click **Save Changes**

The service will automatically rebuild and restart.

### Step 5: Verify Deployment

1. Go to **Logs** (in the left sidebar)
2. Wait for the build to complete (2-3 minutes)
3. You should see: `✓ Connected to Planning Center. Found groups.`
4. Note your service **URL** - it will be something like:
   ```
   https://planning-center-mcp.onrender.com
   ```

---

## Local Development

### Prerequisites

- Node.js 18+
- npm or yarn

### Setup

```bash
npm install
```

### Build

```bash
npm run build
```

### Environment Setup

```bash
cp .env.example .env
```

Edit `.env` and add your Planning Center credentials:

```
PCO_CLIENT_ID=your_client_id
PCO_CLIENT_SECRET=your_client_secret
```

### Run Locally

```bash
npm start
```

You should see: `✓ Connected to Planning Center. Found groups.`

---

## Architecture

### Tools Available

1. **list_groups** - List all groups (with pagination)
2. **get_group** - Get specific group details
3. **get_group_types** - List available group types
4. **create_group** - Create a new group
5. **list_people** - List all people
6. **search_people** - Search people by name
7. **get_group_memberships** - List group members
8. **add_person_to_group** - Add member to group
9. **remove_person_from_group** - Remove member from group

### Authentication

Uses Planning Center's HTTP Basic Authentication:
- Username: `PCO_CLIENT_ID`
- Password: `PCO_CLIENT_SECRET`

### API Base

- Endpoint: `https://api.planningcenteronline.com`
- Version: `v2`

---

## Connecting to Claude

Once deployed on Render, you'll configure this MCP server in Claude/Cowork to:

1. Automatically create all 25 groups
2. Manage group memberships
3. Add/remove people from groups
4. Query group information

The exact integration steps depend on your Claude/Cowork configuration.

---

## Troubleshooting

### Build Failed

- Check that `package.json` has correct dependencies
- Ensure `tsconfig.json` exists
- Review logs for specific errors

### Connection Failed

- Verify `PCO_CLIENT_ID` and `PCO_CLIENT_SECRET` are correct
- Check that they haven't expired (regenerate if needed)
- Ensure network connectivity to `api.planningcenteronline.com`

### Service Crashes After Deploy

- Check environment variables are set
- Review logs for error messages
- Verify Node.js version is 18+

### Updating Code

1. Make changes locally
2. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Description of changes"
   git push
   ```
3. Render automatically redeploys on push

---

## Project Structure

```
planning-center-mcp/
├── src/
│   └── index.ts           # Main MCP server implementation
├── package.json           # Node dependencies
├── tsconfig.json          # TypeScript configuration
├── Dockerfile             # Container configuration
├── .env.example           # Environment variables template
└── README.md              # This file
```

---

## Security

- **Never commit `.env` file** - It contains sensitive credentials
- Use Render's environment variable system to store secrets
- Regenerate credentials if accidentally exposed
- Keep dependencies updated for security patches

---

## Support

For issues with:
- **Planning Center API**: https://api.planningcenteronline.com/docs
- **MCP Protocol**: https://modelcontextprotocol.io
- **Render Hosting**: https://render.com/docs
