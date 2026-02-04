# Thinking Tool - QA Checklist

## Prerequisites
- [ ] Smart Connections plugin is installed and enabled
- [ ] Smart Connections has indexed at least some notes
- [ ] AI API key is configured (OpenAI or Anthropic)

## Session Start
- [ ] Open any note in the vault
- [ ] Click the brain icon in ribbon OR run command "Start Thinking Session"
- [ ] Verify 3-panel layout appears:
  - Left: Source note (editable)
  - Center: Related notes list (from Smart Connections)
  - Right: New material note created

## Material Collection
- [ ] Select text in the left panel (source note)
- [ ] Right-click → see "Add as Material" option
- [ ] Click "Add as Material" → modal appears
- [ ] Modal shows quote preview and thought input
- [ ] Submit with thought → material appears in right panel
- [ ] Verify callout format:
  ```
  > [!quote] [[SourceNote]]
  > Selected text
  >
  > **My Thought**: Your thought
  ```

## Connections Navigation
- [ ] Center panel shows related notes with similarity scores
- [ ] Click a related note → opens in left panel
- [ ] Connections list refreshes for new note
- [ ] Can continue collecting materials from new note

## Article Generation
- [ ] Collect at least 2-3 materials
- [ ] Click "Generate" button OR run command
- [ ] AI suggests 3 topic options (requires API key)
- [ ] Select a topic → advance to persona selection
- [ ] Select persona (Essay/Blog/Academic/Twitter)
- [ ] Click "Generate Article" → new note created
- [ ] Article contains backlinks to sources

## Session End
- [ ] Run command "End Thinking Session"
- [ ] Connections view closes
- [ ] Session state resets

## Edge Cases
- [ ] Start session without Smart Connections installed → graceful empty state
- [ ] Start session without API key → error message on generation
- [ ] Multiple sessions → only one allowed at a time
- [ ] Restart Obsidian → no stale session

## Settings
- [ ] Settings tab appears under "Thinking Tool"
- [ ] Can switch AI provider (OpenAI/Anthropic)
- [ ] Can configure API keys
- [ ] Can set connections limit
- [ ] Can set material notes folder
