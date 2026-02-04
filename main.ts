import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  ItemView,
  Menu,
  requestUrl,
  normalizePath,
} from "obsidian";

// ===== Constants =====
const VIEW_TYPE_CONNECTIONS = "thinking-tool-connections";
const MATERIAL_NOTE_SUFFIX = " - Materials";

// ===== Interfaces =====
interface ThinkingToolSettings {
  aiProvider: "openai" | "anthropic";
  openaiApiKey: string;
  anthropicApiKey: string;
  openaiModel: string;
  anthropicModel: string;
  materialNoteFolder: string;
  connectionsLimit: number;
  outputLanguage: string;
}

interface ThinkingSession {
  isActive: boolean;
  sourceFilePath: string | null;
  materialNotePath: string | null;
  leftLeafId: string | null;
  centerLeafId: string | null;
  rightLeafId: string | null;
}

interface ConnectionResult {
  item: {
    path: string;
    key: string;
    data?: {
      path?: string;
    };
  };
  score: number;
}

interface TopicSuggestion {
  title: string;
  description: string;
  outline: string[];
}

type Persona = "essay" | "blog" | "academic" | "twitter" | "custom";

const DEFAULT_SETTINGS: ThinkingToolSettings = {
  aiProvider: "openai",
  openaiApiKey: "",
  anthropicApiKey: "",
  openaiModel: "gpt-4o",
  anthropicModel: "claude-sonnet-4-20250514",
  materialNoteFolder: "",
  connectionsLimit: 20,
  outputLanguage: "한국어",
};

// ===== Main Plugin Class =====
export default class ThinkingToolPlugin extends Plugin {
  settings: ThinkingToolSettings = DEFAULT_SETTINGS;
  session: ThinkingSession = {
    isActive: false,
    sourceFilePath: null,
    materialNotePath: null,
    leftLeafId: null,
    centerLeafId: null,
    rightLeafId: null,
  };

  async onload() {
    await this.loadSettings();

    // Register the connections view
    this.registerView(
      VIEW_TYPE_CONNECTIONS,
      (leaf) => new ConnectionsView(leaf, this)
    );

    // Add command to start thinking session
    this.addCommand({
      id: "start-thinking-session",
      name: "Start Thinking Session",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          if (!checking) {
            this.startThinkingSession(activeFile);
          }
          return true;
        }
        return false;
      },
    });

    // Add command to end thinking session
    this.addCommand({
      id: "end-thinking-session",
      name: "End Thinking Session",
      checkCallback: (checking: boolean) => {
        if (this.session.isActive) {
          if (!checking) {
            this.endThinkingSession();
          }
          return true;
        }
        return false;
      },
    });

    // Add command to generate article
    this.addCommand({
      id: "generate-article",
      name: "Generate Article from Materials",
      checkCallback: (checking: boolean) => {
        if (this.session.isActive && this.session.materialNotePath) {
          if (!checking) {
            this.openGenerateModal();
          }
          return true;
        }
        return false;
      },
    });

    // Register editor context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        // Always show menu item if session is active
        if (!this.session.isActive) {
          return;
        }

        const selectedText = editor.getSelection();
        if (!selectedText || selectedText.trim().length === 0) {
          return;
        }

        // Get file from the MarkdownView
        const markdownView = info instanceof MarkdownView ? info : null;
        const file = markdownView?.file || this.app.workspace.getActiveFile();

        menu.addItem((item) => {
          item
            .setTitle("📝 소재로 추가")
            .setIcon("plus-circle")
            .onClick(() => {
              if (file) {
                this.openThoughtModal(selectedText, file.path);
              } else {
                new Notice("Cannot determine source file");
              }
            });
        });
      })
    );

    // Register active file change listener
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!this.session.isActive) return;
        if (!leaf) return;

        // Check if the change is in the left pane (source note area)
        const state = leaf.getViewState();
        if (state.type === "markdown") {
          const file = (leaf.view as MarkdownView).file;
          if (file && file.path !== this.session.materialNotePath) {
            // Update connections view
            this.refreshConnectionsView(file.path);
          }
        }
      })
    );

    // Add settings tab
    this.addSettingTab(new ThinkingToolSettingTab(this.app, this));

    // Add ribbon icon
    this.addRibbonIcon("brain", "Start Thinking Tool", () => {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        this.startThinkingSession(activeFile);
      } else {
        new Notice("Please open a note first");
      }
    });

    // Setup floating selection button
    this.setupSelectionListener();
  }

  onunload() {
    // Clean up views
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CONNECTIONS);
    // Clean up floating button
    this.removeFloatingButton();
  }

  // ===== Floating Selection Button =====
  private floatingBtn: HTMLElement | null = null;
  private currentSelection: string = "";

  private setupSelectionListener() {
    // Create floating button (hidden by default)
    this.floatingBtn = document.createElement("button");
    this.floatingBtn.addClass("thinking-tool-floating-btn");
    this.floatingBtn.setText("📝 소재로 추가");
    this.floatingBtn.style.display = "none";
    document.body.appendChild(this.floatingBtn);

    this.floatingBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.currentSelection) {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          this.openThoughtModal(this.currentSelection, activeFile.path);
        }
      }
      this.hideFloatingButton();
    };

    // Listen for mouseup to detect selection
    this.registerDomEvent(document, "mouseup", (e: MouseEvent) => {
      // Small delay to let selection complete
      setTimeout(() => this.handleSelectionChange(e), 10);
    });

    // Hide on scroll or click elsewhere
    this.registerDomEvent(document, "mousedown", (e: MouseEvent) => {
      if (this.floatingBtn && !this.floatingBtn.contains(e.target as Node)) {
        this.hideFloatingButton();
      }
    });

    this.registerDomEvent(document, "keydown", () => {
      this.hideFloatingButton();
    });
  }

  private handleSelectionChange(e: MouseEvent) {
    if (!this.session.isActive) return;

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (selectedText && selectedText.length > 0) {
      this.currentSelection = selectedText;
      this.showFloatingButton(e.clientX, e.clientY);
    } else {
      this.hideFloatingButton();
    }
  }

  private showFloatingButton(x: number, y: number) {
    if (!this.floatingBtn) return;

    // Position near the cursor but not overlapping
    const btnWidth = 120;
    const btnHeight = 32;
    
    // Keep within viewport
    let posX = x - btnWidth / 2;
    let posY = y - btnHeight - 10; // Above cursor
    
    if (posX < 10) posX = 10;
    if (posX + btnWidth > window.innerWidth - 10) posX = window.innerWidth - btnWidth - 10;
    if (posY < 10) posY = y + 20; // Below cursor if no space above

    this.floatingBtn.style.left = `${posX}px`;
    this.floatingBtn.style.top = `${posY}px`;
    this.floatingBtn.style.display = "block";
  }

  private hideFloatingButton() {
    if (this.floatingBtn) {
      this.floatingBtn.style.display = "none";
    }
    this.currentSelection = "";
  }

  private removeFloatingButton() {
    if (this.floatingBtn) {
      this.floatingBtn.remove();
      this.floatingBtn = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ===== Session Management =====
  async startThinkingSession(sourceFile: TFile) {
    if (this.session.isActive) {
      new Notice("A thinking session is already active. End it first.");
      return;
    }

    // Create material note
    const materialNotePath = await this.createMaterialNote(sourceFile);
    if (!materialNotePath) {
      new Notice("Failed to create material note");
      return;
    }

    // Set up session
    this.session = {
      isActive: true,
      sourceFilePath: sourceFile.path,
      materialNotePath: materialNotePath,
      leftLeafId: null,
      centerLeafId: null,
      rightLeafId: null,
    };

    // Create 3-panel layout
    await this.setupThreePanelLayout(sourceFile.path, materialNotePath);

    new Notice("Thinking session started! Select text and right-click to add materials.");
  }

  async endThinkingSession() {
    if (!this.session.isActive) return;

    // Reset session
    this.session = {
      isActive: false,
      sourceFilePath: null,
      materialNotePath: null,
      leftLeafId: null,
      centerLeafId: null,
      rightLeafId: null,
    };

    // Detach connections view
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CONNECTIONS);

    new Notice("Thinking session ended");
  }

  // ===== Material Note Management =====
  async createMaterialNote(sourceFile: TFile): Promise<string | null> {
    const baseName = sourceFile.basename + MATERIAL_NOTE_SUFFIX;
    let folderPath = this.settings.materialNoteFolder || sourceFile.parent?.path || "";
    
    // Normalize the folder path
    folderPath = normalizePath(folderPath);

    // Ensure folder exists
    if (folderPath) {
      const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
      if (!existingFolder) {
        try {
          await this.app.vault.createFolder(folderPath);
        } catch (e) {
          // Folder might already exist or be created by another process
          console.log("Folder creation note:", e);
        }
      } else if (!(existingFolder instanceof TFolder)) {
        // Path exists but is a file, not a folder - use root
        console.warn("Path is a file, not folder. Using vault root.");
        folderPath = "";
      }
    }

    // Build file path
    const folder = folderPath ? folderPath + "/" : "";
    let fileName = normalizePath(`${folder}${baseName}.md`);
    let counter = 1;

    // Handle name collisions
    while (this.app.vault.getAbstractFileByPath(fileName)) {
      fileName = normalizePath(`${folder}${baseName} ${counter}.md`);
      counter++;
    }

    const content = `# Materials from [[${sourceFile.basename}]]\n\n> [!info] Thinking Tool Session\n> This note collects materials for article generation.\n> Source: [[${sourceFile.basename}]]\n\n---\n\n`;

    try {
      await this.app.vault.create(fileName, content);
      return fileName;
    } catch (error) {
      console.error("Failed to create material note:", error);
      // Try creating in vault root as fallback
      try {
        const rootFileName = normalizePath(`${baseName}.md`);
        await this.app.vault.create(rootFileName, content);
        new Notice("Material note created in vault root (folder issue)");
        return rootFileName;
      } catch (rootError) {
        console.error("Failed to create material note in root:", rootError);
        return null;
      }
    }
  }

  async appendMaterial(quote: string, sourcePath: string, thought: string) {
    if (!this.session.materialNotePath) return;

    const materialFile = this.app.vault.getAbstractFileByPath(
      this.session.materialNotePath
    );
    if (!(materialFile instanceof TFile)) return;

    const sourceBasename = sourcePath.replace(/\.md$/, "").split("/").pop();
    const materialBlock = `
> [!quote] [[${sourceBasename}]]
> ${quote.split("\n").join("\n> ")}
>
> **My Thought**: ${thought || "_No thought added_"}

---

`;

    const currentContent = await this.app.vault.read(materialFile);
    await this.app.vault.modify(materialFile, currentContent + materialBlock);

    new Notice("Material added!");
  }

  // ===== Workspace Layout =====
  async setupThreePanelLayout(sourcePath: string, materialPath: string) {
    const workspace = this.app.workspace;

    // Keep the current active leaf as-is (user's existing note)
    const activeLeaf = workspace.getLeaf();
    
    // Create Connections view on the RIGHT of current note
    const connectionsLeaf = workspace.createLeafBySplit(activeLeaf, "vertical");
    await connectionsLeaf.setViewState({
      type: VIEW_TYPE_CONNECTIONS,
      active: false,
      state: { sourcePath },
    });

    // Create Material note on the RIGHT of connections
    const materialLeaf = workspace.createLeafBySplit(connectionsLeaf, "vertical");
    await materialLeaf.openFile(
      this.app.vault.getAbstractFileByPath(materialPath) as TFile
    );

    // Focus back on original note for editing
    workspace.setActiveLeaf(activeLeaf, { focus: true });

    // Store leaf references
    this.session.leftLeafId = (activeLeaf as any).id;
    this.session.centerLeafId = (connectionsLeaf as any).id;
    this.session.rightLeafId = (materialLeaf as any).id;

    // Initial connections load
    this.refreshConnectionsView(sourcePath);
  }

  // ===== Connections View Refresh =====
  async refreshConnectionsView(sourcePath: string) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONNECTIONS);
    for (const leaf of leaves) {
      const view = leaf.view as ConnectionsView;
      if (view) {
        await view.loadConnections(sourcePath);
      }
    }
  }

  // ===== Smart Connections Integration =====
  async getSmartConnections(
    filePath: string
  ): Promise<ConnectionResult[] | null> {
    try {
      // Try to get Smart Connections plugin
      const scPlugin = (this.app as any).plugins?.getPlugin?.(
        "smart-connections"
      );
      if (!scPlugin) {
        console.warn("Smart Connections plugin not found");
        return null;
      }

      // Get environment
      const env =
        scPlugin.env ||
        (typeof globalThis !== "undefined"
          ? (globalThis as any).smart_env
          : null);
      if (!env) {
        console.warn("Smart Connections environment not loaded");
        return null;
      }

      // Wait for env to be loaded
      if (env.state !== "loaded") {
        await this.waitForSmartEnv(env);
      }

      // Get source and connections
      const source = env.smart_sources?.get(filePath);
      if (!source) {
        console.warn("Source not found in Smart Connections:", filePath);
        return null;
      }

      // Get connections
      if (source.connections) {
        const results = await source.connections.get_results({
          limit: this.settings.connectionsLimit,
        });
        return results;
      } else if (source.find_connections) {
        // Legacy fallback
        const results = await source.find_connections({
          limit: this.settings.connectionsLimit,
        });
        return results;
      }

      return null;
    } catch (error) {
      console.error("Error getting smart connections:", error);
      return null;
    }
  }

  private waitForSmartEnv(env: any): Promise<void> {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (env.state === "loaded") {
          clearInterval(interval);
          resolve();
        }
      }, 100);

      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 10000);
    });
  }

  // ===== Modal Openers =====
  openThoughtModal(selectedText: string, sourcePath: string) {
    new ThoughtModal(this.app, this, selectedText, sourcePath).open();
  }

  openGenerateModal() {
    new GenerateArticleModal(this.app, this).open();
  }

  // ===== AI Integration =====
  async generateTopicSuggestions(
    materialsContent: string
  ): Promise<TopicSuggestion[]> {
    const language = this.settings.outputLanguage || "한국어";
    
    const prompt = `You are a creative writing assistant. Based on the following collected materials, suggest 3 provocative and interesting topic/angle combinations for an article.

**IMPORTANT: All output must be written in ${language}.**

Materials:
${materialsContent}

For each suggestion, provide:
1. A compelling title (in ${language})
2. A brief description of the angle/approach (in ${language})
3. A simple outline with 3-5 bullet points (in ${language})

Be provocative and creative - suggest angles that might challenge assumptions or offer fresh perspectives.

Respond in JSON format (but content in ${language}):
[
  {
    "title": "...",
    "description": "...",
    "outline": ["point 1", "point 2", "point 3"]
  }
]`;

    const response = await this.callAI(prompt);
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return [];
    } catch {
      console.error("Failed to parse topic suggestions");
      return [];
    }
  }

  async generateArticle(
    materialsContent: string,
    topic: TopicSuggestion,
    persona: Persona
  ): Promise<string> {
    const language = this.settings.outputLanguage || "한국어";
    
    const personaPrompts: Record<Persona, string> = {
      essay:
        `Write in a thoughtful, reflective essay style with depth and nuance. Use literary techniques and personal insights. Write entirely in ${language}.`,
      blog: `Write in a friendly, conversational blog style. Be engaging and accessible while maintaining substance. Write entirely in ${language}.`,
      academic:
        `Write in a formal academic style with clear argumentation, citations where appropriate, and rigorous analysis. Write entirely in ${language}.`,
      twitter:
        `Write as a compelling Twitter/X thread. Use short, punchy sentences. Include hooks and build tension. Format as numbered tweets. Write entirely in ${language}.`,
      custom:
        `Write in a clear, professional style that balances accessibility with depth. Write entirely in ${language}.`,
    };

    const prompt = `You are a skilled writer. Write an article based on the following:

**IMPORTANT: The entire article must be written in ${language}.**

Topic: ${topic.title}
Approach: ${topic.description}
Outline:
${topic.outline.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Materials to incorporate:
${materialsContent}

Style: ${personaPrompts[persona]}

Important:
- Write the entire article in ${language}
- Incorporate the collected materials naturally
- Stay true to the user's collected thoughts and insights
- Don't add information that contradicts the materials
- Make the article coherent and well-structured

Write the complete article in ${language} now:`;

    return await this.callAI(prompt);
  }

  private async callAI(prompt: string): Promise<string> {
    if (this.settings.aiProvider === "openai") {
      return await this.callOpenAI(prompt);
    } else {
      return await this.callAnthropic(prompt);
    }
  }

  private async callOpenAI(prompt: string): Promise<string> {
    if (!this.settings.openaiApiKey) {
      throw new Error("OpenAI API key not configured");
    }

    const response = await requestUrl({
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.settings.openaiModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4000,
        temperature: 0.7,
      }),
    });

    if (response.status !== 200) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    return response.json.choices[0].message.content;
  }

  private async callAnthropic(prompt: string): Promise<string> {
    if (!this.settings.anthropicApiKey) {
      throw new Error("Anthropic API key not configured");
    }

    const response = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": this.settings.anthropicApiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.settings.anthropicModel,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (response.status !== 200) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    return response.json.content[0].text;
  }

  // ===== Article Creation =====
  async createArticleNote(
    content: string,
    topic: TopicSuggestion
  ): Promise<TFile | null> {
    if (!this.session.materialNotePath) return null;

    const materialFile = this.app.vault.getAbstractFileByPath(
      this.session.materialNotePath
    );
    if (!(materialFile instanceof TFile)) return null;

    const folder = materialFile.parent?.path || "";
    const baseName = topic.title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 50);
    let fileName = folder ? `${folder}/${baseName}.md` : `${baseName}.md`;
    let counter = 1;

    while (this.app.vault.getAbstractFileByPath(fileName)) {
      fileName = folder
        ? `${folder}/${baseName} ${counter}.md`
        : `${baseName} ${counter}.md`;
      counter++;
    }

    const materialBasename = this.session.materialNotePath
      .replace(/\.md$/, "")
      .split("/")
      .pop();

    const fullContent = `# ${topic.title}

> [!info] Generated with Thinking Tool
> Materials: [[${materialBasename}]]
> Generated: ${new Date().toISOString().split("T")[0]}

---

${content}

---

## Sources

- Materials: [[${materialBasename}]]
`;

    try {
      const file = await this.app.vault.create(fileName, fullContent);
      return file;
    } catch (error) {
      console.error("Failed to create article note:", error);
      return null;
    }
  }
}

// ===== Connections View =====
class ConnectionsView extends ItemView {
  plugin: ThinkingToolPlugin;
  currentSourcePath: string | null = null;
  connections: ConnectionResult[] = [];
  isLoading: boolean = false;

  constructor(leaf: WorkspaceLeaf, plugin: ThinkingToolPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CONNECTIONS;
  }

  getDisplayText(): string {
    return "Smart Connections";
  }

  getIcon(): string {
    return "link";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("thinking-tool-connections-view");

    this.render();
  }

  async onClose() {
    // Cleanup
  }

  async loadConnections(sourcePath: string) {
    this.currentSourcePath = sourcePath;
    this.isLoading = true;
    this.render();

    const results = await this.plugin.getSmartConnections(sourcePath);
    this.connections = results || [];
    this.isLoading = false;
    this.render();
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();

    // Header
    const header = container.createDiv({ cls: "view-header" });
    header.createEl("h4", { text: "Related Notes" });

    const actions = header.createDiv({ cls: "view-actions" });
    
    const refreshBtn = actions.createEl("button", { text: "↻" });
    refreshBtn.setAttribute("title", "Refresh");
    refreshBtn.onclick = () => {
      if (this.currentSourcePath) {
        this.loadConnections(this.currentSourcePath);
      }
    };

    const generateBtn = actions.createEl("button", { text: "✍️ 글쓰기" });
    generateBtn.setAttribute("title", "Generate Article");
    generateBtn.onclick = () => {
      this.plugin.openGenerateModal();
    };

    const endBtn = actions.createEl("button", { text: "🏁 마감" });
    endBtn.setAttribute("title", "End Session");
    endBtn.style.backgroundColor = "var(--interactive-accent)";
    endBtn.style.color = "var(--text-on-accent)";
    endBtn.onclick = () => {
      this.plugin.endThinkingSession();
    };

    // Content
    if (this.isLoading) {
      container.createDiv({ cls: "loading-state", text: "Loading connections..." });
      return;
    }

    if (this.connections.length === 0) {
      const emptyState = container.createDiv({ cls: "empty-state" });
      emptyState.createDiv({ cls: "empty-icon", text: "🔗" });
      emptyState.createEl("p", {
        text: "No connections found. Make sure Smart Connections plugin is installed and has indexed your notes.",
      });
      return;
    }

    // Connections list
    const list = container.createDiv({ cls: "connections-list" });

    for (const conn of this.connections) {
      // Extract path from various possible locations in Smart Connections data
      let rawPath = conn.item?.path || conn.item?.data?.path || conn.item?.key || "";
      
      // Handle block references (remove #heading or #^blockid)
      let filePath = rawPath.split("#")[0];
      
      // Ensure .md extension
      if (filePath && !filePath.endsWith(".md")) {
        filePath = filePath + ".md";
      }
      
      if (!filePath) continue;

      const item = list.createDiv({ cls: "connection-item" });

      const title = filePath.split("/").pop()?.replace(/\.md$/, "") || filePath;
      item.createSpan({ cls: "connection-title", text: title });

      const score = Math.round((conn.score || 0) * 100);
      item.createSpan({ cls: "connection-score", text: `${score}%` });

      // Store path in data attribute for debugging
      item.dataset.path = filePath;

      // Use a closure to capture the correct filePath
      const clickHandler = async (targetPath: string) => {
        console.log("ThinkingTool: Click handler fired for path:", targetPath);
        
        // Try to find the file
        let file = this.app.vault.getAbstractFileByPath(targetPath);
        
        // If not found, try without .md extension
        if (!file && targetPath.endsWith(".md")) {
          file = this.app.vault.getAbstractFileByPath(targetPath.slice(0, -3));
        }
        
        // Try to find by basename in case path is wrong
        if (!file) {
          const basename = targetPath.split("/").pop()?.replace(/\.md$/, "");
          if (basename) {
            const allFiles = this.app.vault.getMarkdownFiles();
            file = allFiles.find(f => f.basename === basename) || null;
            console.log("ThinkingTool: Searching by basename:", basename, "Found:", file?.path);
          }
        }
        
        if (!(file instanceof TFile)) {
          new Notice("File not found: " + targetPath);
          console.error("ThinkingTool: File not found:", targetPath);
          return;
        }
        
        console.log("ThinkingTool: Found file:", file.path);
        
        // Find the left leaf - look for markdown views that aren't the material note
        const materialPath = this.plugin.session.materialNotePath;
        let targetLeaf: WorkspaceLeaf | null = null;
        
        // Get all markdown leaves
        const allLeaves = this.app.workspace.getLeavesOfType("markdown");
        console.log("ThinkingTool: Found markdown leaves:", allLeaves.length);
        
        for (const leaf of allLeaves) {
          const leafFile = (leaf.view as any)?.file?.path;
          console.log("ThinkingTool: Checking leaf with file:", leafFile);
          
          // Skip the material note
          if (leafFile !== materialPath) {
            targetLeaf = leaf;
            break;
          }
        }
        
        // Fallback: create new leaf if nothing found
        if (!targetLeaf) {
          console.log("ThinkingTool: No suitable leaf found, creating new one");
          targetLeaf = this.app.workspace.getLeaf("split", "vertical");
        }
        
        try {
          // Open file in the target leaf
          await targetLeaf.openFile(file);
          
          // Update the stored left leaf ID
          this.plugin.session.leftLeafId = (targetLeaf as any).id;
          
          // Focus on the leaf for text selection
          this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
          
          // Refresh connections for new file
          await this.loadConnections(file.path);
          
          new Notice(`📄 ${file.basename}`);
          console.log("ThinkingTool: Successfully opened file");
        } catch (err) {
          console.error("ThinkingTool: Error opening file:", err);
          new Notice("Error opening file: " + err);
        }
      };

      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        clickHandler(filePath);
      });
    }
  }
}

// ===== Thought Modal =====
class ThoughtModal extends Modal {
  plugin: ThinkingToolPlugin;
  selectedText: string;
  sourcePath: string;

  constructor(
    app: App,
    plugin: ThinkingToolPlugin,
    selectedText: string,
    sourcePath: string
  ) {
    super(app);
    this.plugin = plugin;
    this.selectedText = selectedText;
    this.sourcePath = sourcePath;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("thinking-tool-modal");

    contentEl.createEl("h2", { text: "Add Material" });

    // Quote preview
    const preview = contentEl.createDiv({ cls: "quote-preview" });
    preview.setText(
      this.selectedText.length > 200
        ? this.selectedText.slice(0, 200) + "..."
        : this.selectedText
    );

    // Source info
    const sourceBasename = this.sourcePath.split("/").pop()?.replace(/\.md$/, "");
    contentEl.createDiv({
      cls: "source-info",
      text: `From: ${sourceBasename}`,
    });

    // Thought input
    const inputContainer = contentEl.createDiv({ cls: "thought-input-container" });
    inputContainer.createEl("label", { text: "What's your thought on this?" });
    const textarea = inputContainer.createEl("textarea", { cls: "thought-input" });
    textarea.placeholder = "Add your reflection, connection, or insight...";

    // Buttons
    const buttons = contentEl.createDiv({ cls: "modal-buttons" });

    const cancelBtn = buttons.createEl("button", {
      cls: "btn-secondary",
      text: "Cancel",
    });
    cancelBtn.onclick = () => this.close();

    const addBtn = buttons.createEl("button", {
      cls: "btn-primary",
      text: "Add Material",
    });
    addBtn.onclick = async () => {
      await this.plugin.appendMaterial(
        this.selectedText,
        this.sourcePath,
        textarea.value
      );
      this.close();
    };

    // Focus textarea
    setTimeout(() => textarea.focus(), 100);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ===== Generate Article Modal =====
class GenerateArticleModal extends Modal {
  plugin: ThinkingToolPlugin;
  step: number = 1;
  topics: TopicSuggestion[] = [];
  selectedTopic: TopicSuggestion | null = null;
  selectedPersona: Persona = "essay";
  isGenerating: boolean = false;

  constructor(app: App, plugin: ThinkingToolPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("thinking-tool-generate-modal");

    await this.render();
  }

  async render() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Generate Article" });

    // Step indicator
    const stepIndicator = contentEl.createDiv({ cls: "step-indicator" });
    for (let i = 1; i <= 3; i++) {
      const stepDiv = stepIndicator.createDiv({
        cls: `step ${i === this.step ? "active" : ""}`,
      });
      stepDiv.createSpan({ cls: "step-number", text: String(i) });
      stepDiv.createSpan({
        text: i === 1 ? "Topics" : i === 2 ? "Persona" : "Generate",
      });
    }

    if (this.isGenerating) {
      const generating = contentEl.createDiv({ cls: "generating-state" });
      generating.createDiv({ cls: "spinner" });
      generating.createEl("p", { text: "Generating..." });
      return;
    }

    if (this.step === 1) {
      await this.renderStep1(contentEl);
    } else if (this.step === 2) {
      this.renderStep2(contentEl);
    }
  }

  async renderStep1(contentEl: HTMLElement) {
    if (this.topics.length === 0) {
      contentEl.createEl("p", { text: "Analyzing your materials..." });

      // Get materials content
      const materialsContent = await this.getMaterialsContent();
      if (!materialsContent) {
        contentEl.empty();
        contentEl.createEl("p", {
          text: "No materials found. Add some materials first!",
        });
        return;
      }

      try {
        this.topics = await this.plugin.generateTopicSuggestions(
          materialsContent
        );
        this.render();
        return;
      } catch (error) {
        contentEl.empty();
        contentEl.createEl("p", {
          text: `Error generating topics: ${error}`,
        });
        return;
      }
    }

    contentEl.createEl("h3", { text: "Choose a Topic Angle" });

    const topicsContainer = contentEl.createDiv({ cls: "topic-options" });

    for (const topic of this.topics) {
      const option = topicsContainer.createDiv({
        cls: `topic-option ${this.selectedTopic === topic ? "selected" : ""}`,
      });
      option.createDiv({ cls: "topic-title", text: topic.title });
      option.createDiv({ cls: "topic-description", text: topic.description });

      option.onclick = () => {
        this.selectedTopic = topic;
        this.render();
      };
    }

    // Buttons
    const buttons = contentEl.createDiv({ cls: "modal-buttons" });

    const cancelBtn = buttons.createEl("button", {
      cls: "btn-secondary",
      text: "Cancel",
    });
    cancelBtn.onclick = () => this.close();

    const nextBtn = buttons.createEl("button", {
      cls: "btn-primary",
      text: "Next",
    });
    nextBtn.disabled = !this.selectedTopic;
    nextBtn.onclick = () => {
      if (this.selectedTopic) {
        this.step = 2;
        this.render();
      }
    };
  }

  renderStep2(contentEl: HTMLElement) {
    contentEl.createEl("h3", { text: "Choose Writing Style" });

    const personas: { key: Persona; label: string }[] = [
      { key: "essay", label: "📝 Essay" },
      { key: "blog", label: "💬 Blog" },
      { key: "academic", label: "📚 Academic" },
      { key: "twitter", label: "🐦 Twitter Thread" },
    ];

    const personaContainer = contentEl.createDiv({ cls: "persona-selector" });

    for (const persona of personas) {
      const option = personaContainer.createDiv({
        cls: `persona-option ${this.selectedPersona === persona.key ? "selected" : ""}`,
      });
      option.setText(persona.label);

      option.onclick = () => {
        this.selectedPersona = persona.key;
        this.render();
      };
    }

    // Buttons
    const buttons = contentEl.createDiv({ cls: "modal-buttons" });

    const backBtn = buttons.createEl("button", {
      cls: "btn-secondary",
      text: "Back",
    });
    backBtn.onclick = () => {
      this.step = 1;
      this.render();
    };

    const generateBtn = buttons.createEl("button", {
      cls: "btn-primary",
      text: "Generate Article",
    });
    generateBtn.onclick = async () => {
      await this.generateArticle();
    };
  }

  async getMaterialsContent(): Promise<string | null> {
    if (!this.plugin.session.materialNotePath) return null;

    const file = this.app.vault.getAbstractFileByPath(
      this.plugin.session.materialNotePath
    );
    if (!(file instanceof TFile)) return null;

    return await this.app.vault.read(file);
  }

  async generateArticle() {
    if (!this.selectedTopic) return;

    this.isGenerating = true;
    this.render();

    try {
      const materialsContent = await this.getMaterialsContent();
      if (!materialsContent) {
        throw new Error("Could not read materials");
      }

      const article = await this.plugin.generateArticle(
        materialsContent,
        this.selectedTopic,
        this.selectedPersona
      );

      const file = await this.plugin.createArticleNote(
        article,
        this.selectedTopic
      );

      if (file) {
        new Notice("Article created!");
        // Open the new article
        const leaf = this.app.workspace.getLeaf();
        await leaf.openFile(file);
        this.close();
      } else {
        throw new Error("Failed to create article note");
      }
    } catch (error) {
      new Notice(`Error: ${error}`);
      this.isGenerating = false;
      this.render();
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ===== Settings Tab =====
class ThinkingToolSettingTab extends PluginSettingTab {
  plugin: ThinkingToolPlugin;

  constructor(app: App, plugin: ThinkingToolPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("thinking-tool-settings");

    containerEl.createEl("h2", { text: "Thinking Tool Settings" });

    // AI Provider Section
    containerEl.createEl("h3", { text: "AI Provider" });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Choose your AI provider")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("openai", "OpenAI")
          .addOption("anthropic", "Anthropic (Claude)")
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (value: "openai" | "anthropic") => {
            this.plugin.settings.aiProvider = value;
            await this.plugin.saveSettings();
          })
      );

    // OpenAI Settings
    containerEl.createEl("h4", { text: "OpenAI" });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Your OpenAI API key")
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.openaiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openaiApiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("OpenAI model to use")
      .addText((text) =>
        text
          .setPlaceholder("gpt-4o")
          .setValue(this.plugin.settings.openaiModel)
          .onChange(async (value) => {
            this.plugin.settings.openaiModel = value;
            await this.plugin.saveSettings();
          })
      );

    // Anthropic Settings
    containerEl.createEl("h4", { text: "Anthropic" });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Your Anthropic API key")
      .addText((text) =>
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange(async (value) => {
            this.plugin.settings.anthropicApiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Anthropic model to use")
      .addText((text) =>
        text
          .setPlaceholder("claude-sonnet-4-20250514")
          .setValue(this.plugin.settings.anthropicModel)
          .onChange(async (value) => {
            this.plugin.settings.anthropicModel = value;
            await this.plugin.saveSettings();
          })
      );

    // General Settings
    containerEl.createEl("h3", { text: "General" });

    new Setting(containerEl)
      .setName("Material Notes Folder")
      .setDesc("Folder to save material notes (leave empty for same folder as source)")
      .addText((text) =>
        text
          .setPlaceholder("Materials")
          .setValue(this.plugin.settings.materialNoteFolder)
          .onChange(async (value) => {
            this.plugin.settings.materialNoteFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Connections Limit")
      .setDesc("Maximum number of related notes to show")
      .addSlider((slider) =>
        slider
          .setLimits(5, 50, 5)
          .setValue(this.plugin.settings.connectionsLimit)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.connectionsLimit = value;
            await this.plugin.saveSettings();
          })
      );

    // Writing Settings
    containerEl.createEl("h3", { text: "Writing / 글쓰기" });

    new Setting(containerEl)
      .setName("Output Language / 출력 언어")
      .setDesc("Language for AI-generated content / AI가 생성하는 글의 언어")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("한국어", "한국어 (Korean)")
          .addOption("English", "English")
          .addOption("日本語", "日本語 (Japanese)")
          .addOption("中文", "中文 (Chinese)")
          .addOption("Español", "Español (Spanish)")
          .addOption("Français", "Français (French)")
          .addOption("Deutsch", "Deutsch (German)")
          .setValue(this.plugin.settings.outputLanguage)
          .onChange(async (value) => {
            this.plugin.settings.outputLanguage = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
