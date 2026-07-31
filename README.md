# Role Mention Exporter

A Revenge Classic / Vendetta-compatible Discord Android plugin.

Long-press a server, tap **Copy members by role**, choose a role, and the plugin copies the currently cached matching members in this format:

```text
<@123456789012345678> <@234567890123456789>
```

## Important limitation

Discord's mobile app often keeps only part of a large server's member list in memory. The plugin can only read members currently cached by Discord. For the most complete result, open the server's member list and scroll through it before using the plugin. The picker shows the current cache count and warns when it is below the known server member count.

## Publish it on GitHub

1. Create a new public GitHub repository.
2. Upload every file and folder from this project, including `.github`.
3. Replace the author ID `0` in `plugins/RoleMentionExporter/manifest.json` with your Discord user ID.
4. Push/commit to the `main` branch.
5. Open the repository's **Actions** tab and let **Build and deploy plugin** finish.
6. In **Settings → Pages**, set the source to **Deploy from a branch**, choose `gh-pages`, and select `/ (root)`.
7. Your Revenge plugin URL will be:

```text
https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY_NAME/RoleMentionExporter/
```

You can also use the exact manifest URL:

```text
https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY_NAME/RoleMentionExporter/manifest.json
```

## Local build

```bash
npm install
npm run build
```

The deployable files will be created under `dist/RoleMentionExporter/`.

## Compatibility notes

- This targets the classic Vendetta-style plugin API used by Revenge Classic and by the example plugin repository.
- Discord internal action-sheet names can change. The patch checks several guild-menu naming patterns, but a future Discord update may require changing `isGuildLongPressSheet()` or `findButtonArray()` in `src/index.ts`.
- Third-party Discord client modifications are unofficial. Use them at your own risk.
