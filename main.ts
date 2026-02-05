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
  aiProvider: "gemini" | "openai" | "anthropic";
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  openaiModel: string;
  anthropicModel: string;
  geminiModel: string;
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

type Persona = "essay" | "blog" | "academic" | "twitter" | "newsletter" | "storytelling" | "custom";
type ArticleLength = "short" | "medium" | "long";

interface GenerationOptions {
  topic: TopicSuggestion;
  persona: Persona;
  length: ArticleLength;
  customInstructions?: string;
}

const API_TIMEOUT = 60000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

const DEFAULT_SETTINGS: ThinkingToolSettings = {
  aiProvider: "gemini",
  openaiApiKey: "",
  anthropicApiKey: "",
  geminiApiKey: "",
  openaiModel: "gpt-4o",
  anthropicModel: "claude-sonnet-4-20250514",
  geminiModel: "gemini-2.5-flash-preview-05-20",
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
    materialsContent: string,
    onProgress?: (status: string) => void
  ): Promise<TopicSuggestion[]> {
    const language = this.settings.outputLanguage || "한국어";
    
    const prompt = `You are a creative writing assistant helping a writer craft compelling articles from their collected materials.

**CRITICAL: All output must be written in ${language}.**

## Collected Materials:
${materialsContent}

## Your Task:
Analyze the materials deeply and suggest **5 unique topic angles** for an article. Each suggestion should offer a distinct perspective:

1. **Mainstream Angle**: A conventional, accessible approach that most readers would expect
2. **Contrarian Angle**: A perspective that challenges common assumptions or conventional wisdom
3. **Personal/Emotional Angle**: A deeply personal, story-driven approach
4. **Analytical/Deep-dive Angle**: A thorough, research-oriented perspective
5. **Provocative/Bold Angle**: A daring, attention-grabbing take that sparks discussion

For each suggestion, provide:
- **title**: An engaging, click-worthy title (10-15 words max)
- **description**: A 2-3 sentence description of the angle and why it's compelling
- **outline**: 4-6 key points that structure the article

Respond ONLY with valid JSON (no markdown, no explanation):
[
  {
    "title": "제목",
    "description": "설명",
    "outline": ["포인트1", "포인트2", "포인트3", "포인트4"]
  }
]`;

    onProgress?.("소재 분석 중...");
    const response = await this.callAI(prompt, onProgress);
    
    try {
      const jsonMatch = response.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        const topics = JSON.parse(jsonMatch[0]) as TopicSuggestion[];
        if (Array.isArray(topics) && topics.length > 0) {
          return topics.slice(0, 5);
        }
      }
      throw new Error("유효한 주제를 생성하지 못했습니다.");
    } catch (error) {
      console.error("Failed to parse topic suggestions:", error, response);
      throw new Error("주제 제안 파싱 실패: AI 응답 형식이 올바르지 않습니다.");
    }
  }

  async generateArticle(
    materialsContent: string,
    options: GenerationOptions,
    onProgress?: (status: string) => void
  ): Promise<string> {
    const language = this.settings.outputLanguage || "한국어";
    const { topic, persona, length, customInstructions } = options;
    
    const personaPrompts: Record<Persona, string> = {
      essay: `깊이 있는 성찰적 에세이 스타일. 문학적 기법과 개인적 통찰을 활용하세요. 은유, 비유를 적절히 사용하고 독자의 감정에 호소하세요.`,
      blog: `친근하고 대화하듯 쓰는 블로그 스타일. 접근하기 쉽지만 내용은 충실하게. 독자에게 직접 말을 거는 듯한 톤을 유지하세요.`,
      academic: `학술적이고 논증적인 스타일. 명확한 논리 구조와 근거 제시. 객관적인 톤을 유지하며 체계적으로 서술하세요.`,
      twitter: `트위터/X 스레드 형식. 짧고 강렬한 문장. 각 트윗은 번호를 매기고, 훅(hook)으로 시작해 긴장감을 유지하세요. 이모지 적절히 활용.`,
      newsletter: `뉴스레터 스타일. 독자에게 가치 있는 인사이트 전달. 핵심 포인트를 명확히 하고, 실행 가능한 조언을 포함하세요.`,
      storytelling: `스토리텔링 스타일. 이야기로 시작해 독자를 끌어들이세요. 구체적인 사례와 생생한 묘사를 활용하세요.`,
      custom: `명확하고 전문적인 스타일. 접근성과 깊이의 균형을 맞추세요.`,
    };

    const lengthGuides: Record<ArticleLength, string> = {
      short: "800-1200자 분량의 간결한 글. 핵심만 명확하게 전달하세요.",
      medium: "2000-3000자 분량의 적당한 길이. 충분한 설명과 예시를 포함하세요.",
      long: "4000-5000자 분량의 심층 글. 자세한 분석, 다양한 관점, 풍부한 예시를 포함하세요.",
    };

    const prompt = `당신은 ${language}로 글을 쓰는 숙련된 작가입니다.

## 글 정보
- **제목**: ${topic.title}
- **접근 방식**: ${topic.description}
- **아웃라인**:
${topic.outline.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}

## 참고 소재
${materialsContent}

## 작성 지침
- **스타일**: ${personaPrompts[persona]}
- **분량**: ${lengthGuides[length]}
${customInstructions ? `- **추가 지시**: ${customInstructions}` : ""}

## 중요 규칙
1. 반드시 ${language}로 작성하세요
2. 수집된 소재의 내용과 작성자의 생각을 자연스럽게 녹여내세요
3. 소재와 모순되는 내용을 추가하지 마세요
4. 작성자의 고유한 관점과 목소리를 유지하세요
5. 아웃라인 구조를 따르되, 자연스러운 흐름을 만드세요
6. 도입부에서 독자의 관심을 사로잡고, 결론에서 여운을 남기세요

지금 바로 완성된 글을 작성하세요:`;

    onProgress?.("글 생성 중...");
    return await this.callAI(prompt, onProgress);
  }

  private async callAI(prompt: string, onProgress?: (status: string) => void): Promise<string> {
    const provider = this.settings.aiProvider;
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        onProgress?.(`AI 호출 중... (시도 ${attempt}/${MAX_RETRIES})`);
        
        let result: string;
        if (provider === "gemini") {
          result = await this.callGeminiWithTimeout(prompt);
        } else if (provider === "openai") {
          result = await this.callOpenAIWithTimeout(prompt);
        } else {
          result = await this.callAnthropicWithTimeout(prompt);
        }
        
        return result;
      } catch (error) {
        lastError = error as Error;
        console.error(`AI call attempt ${attempt} failed:`, error);
        
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
          onProgress?.(`재시도 대기 중... (${delay / 1000}초)`);
          await this.sleep(delay);
        }
      }
    }
    
    throw new Error(`AI 호출 실패 (${MAX_RETRIES}회 시도): ${lastError?.message || "알 수 없는 오류"}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`요청 시간 초과 (${timeoutMs / 1000}초)`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timeoutId!);
      return result;
    } catch (error) {
      clearTimeout(timeoutId!);
      throw error;
    }
  }

  private async callOpenAIWithTimeout(prompt: string): Promise<string> {
    if (!this.settings.openaiApiKey) {
      throw new Error("OpenAI API 키가 설정되지 않았습니다. 설정에서 API 키를 입력해주세요.");
    }

    const request = requestUrl({
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

    const response = await this.withTimeout(request, API_TIMEOUT);

    if (response.status === 401) {
      throw new Error("OpenAI API 키가 유효하지 않습니다.");
    } else if (response.status === 429) {
      throw new Error("OpenAI API 사용량 한도 초과. 잠시 후 다시 시도해주세요.");
    } else if (response.status !== 200) {
      throw new Error(`OpenAI API 오류 (${response.status}): ${response.text || "알 수 없는 오류"}`);
    }

    const content = response.json?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI 응답 형식이 올바르지 않습니다.");
    }
    return content;
  }

  private async callAnthropicWithTimeout(prompt: string): Promise<string> {
    if (!this.settings.anthropicApiKey) {
      throw new Error("Anthropic API 키가 설정되지 않았습니다. 설정에서 API 키를 입력해주세요.");
    }

    const request = requestUrl({
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

    const response = await this.withTimeout(request, API_TIMEOUT);

    if (response.status === 401) {
      throw new Error("Anthropic API 키가 유효하지 않습니다.");
    } else if (response.status === 429) {
      throw new Error("Anthropic API 사용량 한도 초과. 잠시 후 다시 시도해주세요.");
    } else if (response.status !== 200) {
      throw new Error(`Anthropic API 오류 (${response.status}): ${response.text || "알 수 없는 오류"}`);
    }

    const content = response.json?.content?.[0]?.text;
    if (!content) {
      throw new Error("Anthropic 응답 형식이 올바르지 않습니다.");
    }
    return content;
  }

  private async callGeminiWithTimeout(prompt: string): Promise<string> {
    if (!this.settings.geminiApiKey) {
      throw new Error("Gemini API 키가 설정되지 않았습니다. 설정에서 API 키를 입력해주세요.");
    }

    const request = requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${this.settings.geminiModel}:generateContent?key=${this.settings.geminiApiKey}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 8000,
          temperature: 0.7,
        },
      }),
    });

    const response = await this.withTimeout(request, API_TIMEOUT);

    if (response.status === 400) {
      throw new Error("Gemini API 키가 유효하지 않거나 요청 형식이 잘못되었습니다.");
    } else if (response.status === 429) {
      throw new Error("Gemini API 사용량 한도 초과. 잠시 후 다시 시도해주세요.");
    } else if (response.status !== 200) {
      throw new Error(`Gemini API 오류 (${response.status}): ${response.text || "알 수 없는 오류"}`);
    }

    const result = response.json;
    const content = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) {
      const blockReason = result?.candidates?.[0]?.finishReason;
      if (blockReason === "SAFETY") {
        throw new Error("안전 필터에 의해 응답이 차단되었습니다. 다른 소재로 시도해주세요.");
      }
      throw new Error("Gemini 응답 형식이 올바르지 않습니다.");
    }
    return content;
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
  editedOutline: string[] = [];
  selectedPersona: Persona = "essay";
  selectedLength: ArticleLength = "medium";
  customInstructions: string = "";
  isLoading: boolean = false;
  loadingStatus: string = "";
  lastError: string | null = null;
  materialsContent: string | null = null;
  materialCount: number = 0;

  constructor(app: App, plugin: ThinkingToolPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("thinking-tool-generate-modal");
    
    this.materialsContent = await this.getMaterialsContent();
    this.materialCount = this.countMaterials(this.materialsContent);
    
    await this.render();
  }

  countMaterials(content: string | null): number {
    if (!content) return 0;
    const matches = content.match(/>\s*\[!quote\]/g);
    return matches ? matches.length : 0;
  }

  async render() {
    const { contentEl } = this;
    contentEl.empty();

    const header = contentEl.createDiv({ cls: "modal-header" });
    header.createEl("h2", { text: "✍️ 글 생성" });
    
    const stepLabels = ["주제 선택", "아웃라인 수정", "스타일 설정", "생성"];
    const stepIndicator = contentEl.createDiv({ cls: "step-indicator" });
    for (let i = 1; i <= 4; i++) {
      const stepDiv = stepIndicator.createDiv({
        cls: `step ${i === this.step ? "active" : ""} ${i < this.step ? "completed" : ""}`,
      });
      stepDiv.createSpan({ cls: "step-number", text: i < this.step ? "✓" : String(i) });
      stepDiv.createSpan({ cls: "step-label", text: stepLabels[i - 1] });
    }

    if (this.lastError) {
      const errorDiv = contentEl.createDiv({ cls: "error-banner" });
      errorDiv.createSpan({ text: `⚠️ ${this.lastError}` });
      const retryBtn = errorDiv.createEl("button", { text: "다시 시도", cls: "btn-retry" });
      retryBtn.onclick = () => {
        this.lastError = null;
        this.render();
        if (this.step === 1 && this.topics.length === 0) {
          this.loadTopics();
        }
      };
    }

    if (this.isLoading) {
      const loadingDiv = contentEl.createDiv({ cls: "loading-state" });
      loadingDiv.createDiv({ cls: "spinner" });
      loadingDiv.createEl("p", { text: this.loadingStatus || "처리 중..." });
      return;
    }

    switch (this.step) {
      case 1:
        await this.renderStep1Topics(contentEl);
        break;
      case 2:
        this.renderStep2Outline(contentEl);
        break;
      case 3:
        this.renderStep3Style(contentEl);
        break;
      case 4:
        await this.renderStep4Generate(contentEl);
        break;
    }
  }

  async renderStep1Topics(contentEl: HTMLElement) {
    if (this.materialCount < 1) {
      const emptyDiv = contentEl.createDiv({ cls: "empty-state" });
      emptyDiv.createDiv({ cls: "empty-icon", text: "📝" });
      emptyDiv.createEl("h3", { text: "소재가 없습니다" });
      emptyDiv.createEl("p", { text: "먼저 노트에서 텍스트를 선택하고 소재로 추가해주세요." });
      
      const closeBtn = contentEl.createEl("button", { cls: "btn-primary", text: "닫기" });
      closeBtn.onclick = () => this.close();
      return;
    }

    const infoDiv = contentEl.createDiv({ cls: "material-info" });
    infoDiv.createSpan({ text: `📚 수집된 소재: ${this.materialCount}개` });

    if (this.topics.length === 0) {
      await this.loadTopics();
      return;
    }

    contentEl.createEl("h3", { text: "주제를 선택하세요" });
    contentEl.createEl("p", { cls: "step-description", text: "AI가 분석한 5가지 관점 중 하나를 선택하거나, 직접 주제를 입력하세요." });

    const topicsContainer = contentEl.createDiv({ cls: "topic-options" });

    for (const topic of this.topics) {
      const isSelected = this.selectedTopic === topic;
      const option = topicsContainer.createDiv({
        cls: `topic-option ${isSelected ? "selected" : ""}`,
      });
      
      const titleRow = option.createDiv({ cls: "topic-title-row" });
      titleRow.createDiv({ cls: "topic-title", text: topic.title });
      if (isSelected) {
        titleRow.createSpan({ cls: "selected-badge", text: "✓ 선택됨" });
      }
      
      option.createDiv({ cls: "topic-description", text: topic.description });
      
      const outlinePreview = option.createDiv({ cls: "outline-preview" });
      topic.outline.slice(0, 3).forEach(point => {
        outlinePreview.createDiv({ cls: "outline-point", text: `• ${point}` });
      });
      if (topic.outline.length > 3) {
        outlinePreview.createDiv({ cls: "outline-more", text: `+${topic.outline.length - 3}개 더...` });
      }

      option.onclick = () => {
        this.selectedTopic = topic;
        this.editedOutline = [...topic.outline];
        this.render();
      };
    }

    const customSection = contentEl.createDiv({ cls: "custom-topic-section" });
    customSection.createEl("h4", { text: "또는 직접 입력" });
    
    const customInput = customSection.createEl("input", {
      cls: "custom-topic-input",
      attr: { type: "text", placeholder: "원하는 주제나 제목을 입력하세요..." }
    });
    
    const customBtn = customSection.createEl("button", { cls: "btn-secondary", text: "이 주제로 진행" });
    customBtn.onclick = () => {
      const title = customInput.value.trim();
      if (title) {
        this.selectedTopic = {
          title,
          description: "사용자 직접 입력 주제",
          outline: ["서론", "본론 1", "본론 2", "결론"]
        };
        this.editedOutline = [...this.selectedTopic.outline];
        this.step = 2;
        this.render();
      } else {
        new Notice("주제를 입력해주세요.");
      }
    };

    const buttons = contentEl.createDiv({ cls: "modal-buttons" });
    
    const refreshBtn = buttons.createEl("button", { cls: "btn-secondary", text: "🔄 다른 주제 제안받기" });
    refreshBtn.onclick = () => {
      this.topics = [];
      this.selectedTopic = null;
      this.render();
    };

    const cancelBtn = buttons.createEl("button", { cls: "btn-secondary", text: "취소" });
    cancelBtn.onclick = () => this.close();

    const nextBtn = buttons.createEl("button", { cls: "btn-primary", text: "다음 →" });
    nextBtn.disabled = !this.selectedTopic;
    nextBtn.onclick = () => {
      if (this.selectedTopic) {
        this.step = 2;
        this.render();
      }
    };
  }

  renderStep2Outline(contentEl: HTMLElement) {
    if (!this.selectedTopic) return;

    contentEl.createEl("h3", { text: "아웃라인 수정" });
    contentEl.createEl("p", { cls: "step-description", text: "글의 구조를 확인하고 필요하면 수정하세요. 항목을 추가/삭제/수정할 수 있습니다." });

    const topicInfo = contentEl.createDiv({ cls: "selected-topic-info" });
    topicInfo.createEl("strong", { text: this.selectedTopic.title });
    topicInfo.createEl("p", { text: this.selectedTopic.description });

    const outlineEditor = contentEl.createDiv({ cls: "outline-editor" });
    
    this.editedOutline.forEach((point, index) => {
      const row = outlineEditor.createDiv({ cls: "outline-row" });
      
      row.createSpan({ cls: "outline-number", text: `${index + 1}.` });
      
      const input = row.createEl("input", {
        cls: "outline-input",
        attr: { type: "text", value: point }
      });
      input.oninput = () => {
        this.editedOutline[index] = input.value;
      };
      
      const deleteBtn = row.createEl("button", { cls: "btn-icon btn-delete", text: "✕" });
      deleteBtn.onclick = () => {
        if (this.editedOutline.length > 2) {
          this.editedOutline.splice(index, 1);
          this.render();
        } else {
          new Notice("최소 2개 이상의 항목이 필요합니다.");
        }
      };
    });

    const addBtn = outlineEditor.createEl("button", { cls: "btn-add-outline", text: "+ 항목 추가" });
    addBtn.onclick = () => {
      this.editedOutline.push("새 항목");
      this.render();
    };

    const buttons = contentEl.createDiv({ cls: "modal-buttons" });
    
    const backBtn = buttons.createEl("button", { cls: "btn-secondary", text: "← 이전" });
    backBtn.onclick = () => {
      this.step = 1;
      this.render();
    };

    const nextBtn = buttons.createEl("button", { cls: "btn-primary", text: "다음 →" });
    nextBtn.onclick = () => {
      this.selectedTopic!.outline = [...this.editedOutline];
      this.step = 3;
      this.render();
    };
  }

  renderStep3Style(contentEl: HTMLElement) {
    contentEl.createEl("h3", { text: "스타일 설정" });
    contentEl.createEl("p", { cls: "step-description", text: "글의 스타일과 길이를 선택하세요." });

    contentEl.createEl("h4", { text: "글 스타일" });
    const personas: { key: Persona; label: string; desc: string }[] = [
      { key: "essay", label: "📝 에세이", desc: "깊이 있는 성찰적 글" },
      { key: "blog", label: "💬 블로그", desc: "친근하고 대화체" },
      { key: "newsletter", label: "📧 뉴스레터", desc: "인사이트 전달" },
      { key: "storytelling", label: "📖 스토리텔링", desc: "이야기로 풀어내기" },
      { key: "academic", label: "📚 학술적", desc: "논증적, 체계적" },
      { key: "twitter", label: "🐦 트위터 스레드", desc: "짧고 강렬하게" },
    ];

    const personaContainer = contentEl.createDiv({ cls: "persona-selector" });
    for (const persona of personas) {
      const option = personaContainer.createDiv({
        cls: `persona-option ${this.selectedPersona === persona.key ? "selected" : ""}`,
      });
      option.createDiv({ cls: "persona-label", text: persona.label });
      option.createDiv({ cls: "persona-desc", text: persona.desc });
      option.onclick = () => {
        this.selectedPersona = persona.key;
        this.render();
      };
    }

    contentEl.createEl("h4", { text: "글 길이" });
    const lengths: { key: ArticleLength; label: string; desc: string }[] = [
      { key: "short", label: "짧게", desc: "800-1200자" },
      { key: "medium", label: "보통", desc: "2000-3000자" },
      { key: "long", label: "길게", desc: "4000-5000자" },
    ];

    const lengthContainer = contentEl.createDiv({ cls: "length-selector" });
    for (const len of lengths) {
      const option = lengthContainer.createDiv({
        cls: `length-option ${this.selectedLength === len.key ? "selected" : ""}`,
      });
      option.createDiv({ cls: "length-label", text: len.label });
      option.createDiv({ cls: "length-desc", text: len.desc });
      option.onclick = () => {
        this.selectedLength = len.key;
        this.render();
      };
    }

    contentEl.createEl("h4", { text: "추가 지시 (선택사항)" });
    const customArea = contentEl.createEl("textarea", {
      cls: "custom-instructions",
      attr: { placeholder: "예: 독자층은 20-30대 직장인입니다. 실용적인 조언을 강조해주세요." }
    });
    customArea.value = this.customInstructions;
    customArea.oninput = () => {
      this.customInstructions = customArea.value;
    };

    const buttons = contentEl.createDiv({ cls: "modal-buttons" });
    
    const backBtn = buttons.createEl("button", { cls: "btn-secondary", text: "← 이전" });
    backBtn.onclick = () => {
      this.step = 2;
      this.render();
    };

    const generateBtn = buttons.createEl("button", { cls: "btn-primary btn-generate", text: "✨ 글 생성하기" });
    generateBtn.onclick = () => {
      this.step = 4;
      this.render();
    };
  }

  async renderStep4Generate(contentEl: HTMLElement) {
    if (!this.selectedTopic || !this.materialsContent) return;

    this.isLoading = true;
    this.loadingStatus = "글 생성 준비 중...";
    this.render();

    try {
      const options: GenerationOptions = {
        topic: this.selectedTopic,
        persona: this.selectedPersona,
        length: this.selectedLength,
        customInstructions: this.customInstructions || undefined,
      };

      const article = await this.plugin.generateArticle(
        this.materialsContent,
        options,
        (status) => {
          this.loadingStatus = status;
        }
      );

      const file = await this.plugin.createArticleNote(article, this.selectedTopic);

      if (file) {
        new Notice("✅ 글이 생성되었습니다!");
        const leaf = this.app.workspace.getLeaf();
        await leaf.openFile(file);
        this.close();
      } else {
        throw new Error("노트 생성에 실패했습니다.");
      }
    } catch (error) {
      this.isLoading = false;
      this.lastError = (error as Error).message;
      this.step = 3;
      this.render();
    }
  }

  async loadTopics() {
    if (!this.materialsContent) return;

    this.isLoading = true;
    this.loadingStatus = "소재 분석 중...";
    this.render();

    try {
      this.topics = await this.plugin.generateTopicSuggestions(
        this.materialsContent,
        (status) => {
          this.loadingStatus = status;
        }
      );
      this.isLoading = false;
      this.lastError = null;
      this.render();
    } catch (error) {
      this.isLoading = false;
      this.lastError = (error as Error).message;
      this.render();
    }
  }

  async getMaterialsContent(): Promise<string | null> {
    if (!this.plugin.session.materialNotePath) return null;

    const file = this.app.vault.getAbstractFileByPath(
      this.plugin.session.materialNotePath
    );
    if (!(file instanceof TFile)) return null;

    return await this.app.vault.read(file);
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
          .addOption("gemini", "Google Gemini (Recommended)")
          .addOption("openai", "OpenAI")
          .addOption("anthropic", "Anthropic (Claude)")
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (value: "gemini" | "openai" | "anthropic") => {
            this.plugin.settings.aiProvider = value;
            await this.plugin.saveSettings();
          })
      );

    // Gemini Settings
    containerEl.createEl("h4", { text: "Google Gemini" });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Your Google AI Studio API key (aistudio.google.com)")
      .addText((text) =>
        text
          .setPlaceholder("AIza...")
          .setValue(this.plugin.settings.geminiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.geminiApiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Gemini model to use")
      .addText((text) =>
        text
          .setPlaceholder("gemini-2.5-flash-preview-05-20")
          .setValue(this.plugin.settings.geminiModel)
          .onChange(async (value) => {
            this.plugin.settings.geminiModel = value;
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
