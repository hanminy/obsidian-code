/**
 * ObsidianCode - Sidebar chat view
 *
 * Main chat interface for interacting with Claude. This is a thin shell that
 * delegates to specialized controllers for different concerns.
 */

import type { WorkspaceLeaf } from 'obsidian';
import { ItemView, setIcon } from 'obsidian';

import { ObsidianCodeService } from '../../core/agent/ObsidianCodeService';
import { SlashCommandManager } from '../../core/commands';
import type { ClaudeModel, ThinkingBudget } from '../../core/types';
import { DEFAULT_CLAUDE_MODELS, DEFAULT_THINKING_BUDGET, VIEW_TYPE_OBSIDIAN_CODE } from '../../core/types';
import type ObsidianCodePlugin from '../../main';
import {
  cleanupThinkingBlock,
  type ContextUsageMeter,
  createInputToolbar,
  type ExternalContextSelector,
  FileContextManager,
  ImageContextManager,
  type InstructionModeManager,
  InstructionModeManager as InstructionModeManagerClass,
  type McpServerSelector,
  type ModelSelector,
  type PermissionToggle,
  PlanBanner,
  SlashCommandDropdown,
  type ThinkingBudgetSelector,
  TodoPanel,
} from '../../ui';
import { getVaultPath } from '../../utils/path';
import { LOGO_SVG } from './constants';
import {
  ConversationController,
  InputController,
  NavigationController,
  SelectionController,
  StreamController,
} from './controllers';
import { MessageRenderer } from './rendering';
import { AsyncSubagentManager } from './services/AsyncSubagentManager';
import { InstructionRefineService } from './services/InstructionRefineService';
import { TitleGenerationService } from './services/TitleGenerationService';
import { ChatState } from './state';

/** Main sidebar chat view for interacting with Claude. */
export class ObsidianCodeView extends ItemView {
  private plugin: ObsidianCodePlugin;

  /** Per-view agent service so each panel can stream independently. */
  public readonly agentService: ObsidianCodeService;

  /** Conversation pinned to this leaf via setState (workspace restore or "open new panel"). */
  private boundConversationId: string | null = null;

  /** Guard so setState arriving after onOpen triggers a single initial load. */
  private hasLoadedConversation = false;

  // State - public for test access
  public readonly state: ChatState;

  // Controllers
  private selectionController: SelectionController | null = null;
  private conversationController: ConversationController | null = null;
  private streamController: StreamController | null = null;
  private inputController: InputController | null = null;
  private navigationController: NavigationController | null = null;

  // Rendering
  private renderer: MessageRenderer | null = null;

  // Services
  private asyncSubagentManager: AsyncSubagentManager;
  private instructionRefineService: InstructionRefineService | null = null;
  private titleGenerationService: TitleGenerationService | null = null;

  // DOM Elements
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private inputWrapper: HTMLElement | null = null;
  private historyDropdown: HTMLElement | null = null;
  private welcomeEl: HTMLElement | null = null;
  private selectionIndicatorEl: HTMLElement | null = null;

  // UI Components
  public fileContextManager: FileContextManager | null = null;
  private imageContextManager: ImageContextManager | null = null;
  private modelSelector: ModelSelector | null = null;
  private thinkingBudgetSelector: ThinkingBudgetSelector | null = null;
  private externalContextSelector: ExternalContextSelector | null = null;
  private mcpServerSelector: McpServerSelector | null = null;
  private permissionToggle: PermissionToggle | null = null;
  private slashCommandManager: SlashCommandManager | null = null;
  private slashCommandDropdown: SlashCommandDropdown | null = null;
  private instructionModeManager: InstructionModeManager | null = null;
  private contextUsageMeter: ContextUsageMeter | null = null;
  private planBanner: PlanBanner | null = null;
  private todoPanel: TodoPanel | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianCodePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.agentService = new ObsidianCodeService(plugin, plugin.mcpService.getManager());
    this.state = new ChatState({
      onUsageChanged: (usage) => this.contextUsageMeter?.update(usage),
      onTodosChanged: (todos) => this.todoPanel?.updateTodos(todos),
    });
    this.asyncSubagentManager = new AsyncSubagentManager(
      (subagent) => this.streamController?.onAsyncSubagentStateChange(subagent)
    );
  }

  getViewType(): string {
    return VIEW_TYPE_OBSIDIAN_CODE;
  }

  getDisplayText(): string {
    return 'Obsidian Code';
  }

  getIcon(): string {
    return 'bot';
  }

  /** Returns leaf state that Obsidian persists in workspace.json. */
  getState(): Record<string, unknown> {
    const base = super.getState() as Record<string, unknown>;
    return { ...base, conversationId: this.boundConversationId };
  }

  /**
   * Receives leaf state on workspace restore or after `leaf.setViewState({state: {...}})`.
   *
   * Obsidian doesn't strictly guarantee order vs onOpen; both code paths must be
   * idempotent. onOpen also reads leaf state synchronously via
   * hydrateBoundConversationFromLeaf, so this handler covers two cases:
   *   1. State arriving before initial load (boundConversationId not yet consulted) —
   *      record it and the deferred load will use it.
   *   2. State arriving after initial load with a different id — switch panels.
   */
  async setState(state: unknown, result: { history: boolean }): Promise<void> {
    if (state && typeof state === 'object') {
      const cid = (state as { conversationId?: unknown }).conversationId;
      if (typeof cid === 'string' && cid.length > 0) {
        const previousId = this.boundConversationId;
        this.boundConversationId = cid;
        if (this.hasLoadedConversation && previousId !== cid && this.conversationController) {
          if (cid !== this.state.currentConversationId) {
            await this.conversationController.switchTo(cid);
          }
        } else if (!this.hasLoadedConversation) {
          // Initial load hasn't run yet; trigger it (idempotent).
          await this.triggerInitialLoad();
        }
      }
    }
    return super.setState(state as Record<string, unknown>, result);
  }

  getBoundConversationId(): string | null {
    return this.boundConversationId;
  }

  /** Records this leaf's bound conversation and asks Obsidian to persist the workspace. */
  bindConversation(id: string | null): void {
    this.boundConversationId = id;
    this.app.workspace.requestSaveLayout();
  }

  /** Returns another open chat leaf bound to the given conversation id, excluding self. */
  findOtherLeafBoundTo(conversationId: string): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSIDIAN_CODE);
    for (const leaf of leaves) {
      if (leaf === this.leaf) continue;
      const view = leaf.view as ObsidianCodeView;
      if (view?.getBoundConversationId?.() === conversationId) {
        return leaf;
      }
    }
    return null;
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('oc-container');

    // Build header
    const header = container.createDiv({ cls: 'oc-header' });
    this.buildHeader(header);

    // Create plan banner (mounted to container, inserts before messages)
    this.planBanner = new PlanBanner({
      app: this.plugin.app,
      component: this,
    });
    this.planBanner.mount(container);

    // Build messages area
    this.messagesEl = container.createDiv({ cls: 'oc-messages' });

    // Welcome message
    this.welcomeEl = this.messagesEl.createDiv({ cls: 'oc-welcome' });

    // Create todo panel (mounts to messages area, shows at bottom)
    this.todoPanel = new TodoPanel();
    this.todoPanel.mount(this.messagesEl);

    // Build input area
    const inputContainerEl = container.createDiv({ cls: 'oc-input-container' });
    this.buildInputArea(inputContainerEl);

    // Initialize renderer
    this.renderer = new MessageRenderer(
      this.plugin.app,
      this,
      this.messagesEl
    );

    // Initialize controllers
    this.initializeControllers();

    // Wire up event handlers
    this.wireEventHandlers();

    // Start selection polling
    this.selectionController?.start();

    // Read leaf state synchronously so loadActive sees the bound conversation
    // immediately. Avoids depending on Obsidian's setState ordering.
    this.hydrateBoundConversationFromLeaf();
    void this.triggerInitialLoad();
  }

  /** Reads the current leaf's persisted state and seeds boundConversationId. */
  private hydrateBoundConversationFromLeaf(): void {
    const leafState = this.leaf.getViewState()?.state as
      | { conversationId?: unknown }
      | undefined;
    const cid = leafState?.conversationId;
    if (typeof cid === 'string' && cid.length > 0) {
      this.boundConversationId = cid;
    }
  }

  /** Idempotent initial conversation load. Safe to call from onOpen and setState. */
  private async triggerInitialLoad(): Promise<void> {
    if (this.hasLoadedConversation) return;
    if (!this.conversationController) return;
    this.hasLoadedConversation = true;
    await this.conversationController.loadActive();
  }

  async onClose() {
    // Stop polling
    this.selectionController?.stop();
    this.selectionController?.clear();

    // Cleanup navigation controller
    this.navigationController?.dispose();

    // Cleanup thinking state
    cleanupThinkingBlock(this.state.currentThinkingState);
    this.state.currentThinkingState = null;

    // Drop callbacks first so any in-flight stream that tries to fire UI hooks
    // during teardown does not throw. cleanup() is deferred until AFTER save()
    // because cleanup() resets sessionId/approvedPlan and save() needs those.
    this.agentService.setApprovalCallback(null);
    this.agentService.setAskUserQuestionCallback(null);
    this.agentService.setEnterPlanModeCallback(null);
    this.agentService.setExitPlanModeCallback(null);

    // Cancel any in-flight query without resetting session/plan state.
    this.agentService.cancel();

    // Cleanup UI components
    this.fileContextManager?.destroy();
    this.slashCommandDropdown?.destroy();
    this.slashCommandDropdown = null;
    this.slashCommandManager = null;
    this.instructionModeManager?.destroy();
    this.instructionModeManager = null;
    this.instructionRefineService?.cancel();
    this.instructionRefineService = null;
    this.titleGenerationService?.cancel();
    this.titleGenerationService = null;
    this.todoPanel?.destroy();
    this.todoPanel = null;

    // Cleanup async subagents
    this.asyncSubagentManager.orphanAllActive();
    this.state.asyncSubagentStates.clear();

    // Save conversation while sessionId/approvedPlan are still readable from
    // agentService. Then fully reset the per-view service.
    await this.conversationController?.save();
    this.agentService.cleanup();
  }

  // ============================================
  // UI Building
  // ============================================

  private buildHeader(header: HTMLElement) {
    const titleContainer = header.createDiv({ cls: 'oc-title' });
    const logoEl = titleContainer.createSpan({ cls: 'oc-logo' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', LOGO_SVG.viewBox);
    svg.setAttribute('width', LOGO_SVG.width);
    svg.setAttribute('height', LOGO_SVG.height);
    svg.setAttribute('fill', 'none');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', LOGO_SVG.path);
    path.setAttribute('fill', LOGO_SVG.fill);
    svg.appendChild(path);
    logoEl.appendChild(svg);
    titleContainer.createEl('h4', { text: 'Obsidian Code' });

    const headerActions = header.createDiv({ cls: 'oc-header-actions' });

    // History dropdown
    const historyContainer = headerActions.createDiv({ cls: 'oc-history-container' });
    const trigger = historyContainer.createDiv({ cls: 'oc-header-btn' });
    setIcon(trigger, 'history');
    trigger.setAttribute('aria-label', 'Chat history');

    this.historyDropdown = historyContainer.createDiv({ cls: 'oc-history-menu' });

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this.conversationController?.toggleHistoryDropdown();
    });

    // New conversation button
    const newBtn = headerActions.createDiv({ cls: 'oc-header-btn' });
    setIcon(newBtn, 'plus');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', () => this.conversationController?.createNew());
  }

  private buildInputArea(inputContainerEl: HTMLElement) {
    this.inputWrapper = inputContainerEl.createDiv({ cls: 'oc-input-wrapper' });

    // Selection indicator
    this.selectionIndicatorEl = this.inputWrapper.createDiv({ cls: 'oc-selection-indicator' });
    this.selectionIndicatorEl.style.display = 'none';

    // Input textarea
    this.inputEl = this.inputWrapper.createEl('textarea', {
      cls: 'oc-input',
      attr: {
        placeholder: 'How can I help you today?',
        rows: '3',
      },
    });

    // File context manager
    this.fileContextManager = new FileContextManager(
      this.plugin.app,
      inputContainerEl,
      this.inputEl,
      {
        getExcludedTags: () => this.plugin.settings.excludedTags,
        onChipsChanged: () => this.renderer?.scrollToBottomIfNeeded(),
        getExternalContexts: () => this.externalContextSelector?.getExternalContexts() || [],
      }
    );
    this.fileContextManager.setMcpService(this.plugin.mcpService);

    // Image context manager
    this.imageContextManager = new ImageContextManager(
      this.plugin.app,
      inputContainerEl,
      this.inputEl,
      {
        onImagesChanged: () => this.renderer?.scrollToBottomIfNeeded(),
      }
    );

    // Slash command manager
    const vaultPath = getVaultPath(this.plugin.app);
    if (vaultPath) {
      this.slashCommandManager = new SlashCommandManager(this.plugin.app, vaultPath);
      this.slashCommandManager.setCommands(this.plugin.settings.slashCommands);

      this.slashCommandDropdown = new SlashCommandDropdown(
        inputContainerEl,
        this.inputEl,
        {
          onSelect: () => { },
          onHide: () => { },
          getCommands: () => this.plugin.settings.slashCommands,
          reloadCommands: () => this.plugin.reloadSlashCommands(),
        }
      );
    }

    // Instruction mode manager
    this.instructionRefineService = new InstructionRefineService(this.plugin);
    this.titleGenerationService = new TitleGenerationService(this.plugin);
    this.instructionModeManager = new InstructionModeManagerClass(
      this.inputEl,
      {
        onSubmit: async (rawInstruction) => {
          await this.inputController?.handleInstructionSubmit(rawInstruction);
        },
        getInputWrapper: () => this.inputWrapper,
      }
    );

    // Input toolbar
    const inputToolbar = this.inputWrapper.createDiv({ cls: 'oc-input-toolbar' });
    const toolbarComponents = createInputToolbar(inputToolbar, {
      getSettings: () => ({
        model: this.plugin.settings.model,
        thinkingBudget: this.plugin.settings.thinkingBudget,
        permissionMode: this.plugin.settings.permissionMode,
        lastNonPlanPermissionMode: this.plugin.settings.lastNonPlanPermissionMode,
      }),
      getEnvironmentVariables: () => this.plugin.getActiveEnvironmentVariables(),
      isAgentInitiatedPlanMode: () => this.state.planModeState?.agentInitiated ?? false,
      isPlanModeRequested: () => this.state.planModeRequested,
      onModelChange: async (model: ClaudeModel) => {
        this.plugin.settings.model = model;
        const isDefaultModel = DEFAULT_CLAUDE_MODELS.find((m: any) => m.value === model);
        if (isDefaultModel) {
          this.plugin.settings.thinkingBudget = DEFAULT_THINKING_BUDGET[model];
          this.plugin.settings.lastClaudeModel = model;
        } else {
          this.plugin.settings.lastCustomModel = model;
        }
        await this.plugin.saveSettings();
        this.thinkingBudgetSelector?.updateDisplay();
        this.modelSelector?.updateDisplay();
        this.modelSelector?.renderOptions();
      },
      onThinkingBudgetChange: async (budget: ThinkingBudget) => {
        this.plugin.settings.thinkingBudget = budget;
        await this.plugin.saveSettings();
      },
      onPermissionModeChange: async (mode) => {
        const current = this.plugin.settings.permissionMode;
        if (mode === 'plan') {
          if (current !== 'plan') {
            this.plugin.settings.lastNonPlanPermissionMode = current;
          }
        } else {
          this.plugin.settings.lastNonPlanPermissionMode = mode;
        }
        this.plugin.settings.permissionMode = mode;
        await this.plugin.saveSettings();

        if (mode === 'plan') {
          if (!this.state.planModeState?.isActive) {
            this.state.planModeState = {
              isActive: true,
              planFilePath: null,
              planContent: null,
              originalQuery: null,
              agentInitiated: true,
            };
          }
        } else {
          this.state.resetPlanModeState();
        }

        this.updatePlanModeUiState();
      },
    });

    this.modelSelector = toolbarComponents.modelSelector;
    this.thinkingBudgetSelector = toolbarComponents.thinkingBudgetSelector;
    this.contextUsageMeter = toolbarComponents.contextUsageMeter;
    this.externalContextSelector = toolbarComponents.externalContextSelector;
    this.mcpServerSelector = toolbarComponents.mcpServerSelector;
    this.permissionToggle = toolbarComponents.permissionToggle;

    // Wire MCP service
    this.mcpServerSelector.setMcpService(this.plugin.mcpService);

    // Sync @-mentions to UI selector so icon glows when MCP is mentioned
    this.fileContextManager?.setOnMcpMentionChange((servers) => {
      this.mcpServerSelector?.addMentionedServers(servers);
    });

    // Wire external context changes to pre-scan files
    this.externalContextSelector.setOnChange(() => {
      this.fileContextManager?.preScanExternalContexts();
    });
  }

  // ============================================
  // Controller Initialization
  // ============================================

  private initializeControllers() {
    // Selection controller
    this.selectionController = new SelectionController(
      this.plugin.app,
      this.selectionIndicatorEl!,
      this.inputEl!
    );

    // Stream controller
    this.streamController = new StreamController({
      plugin: this.plugin,
      agentService: this.agentService,
      state: this.state,
      renderer: this.renderer!,
      asyncSubagentManager: this.asyncSubagentManager,
      getMessagesEl: () => this.messagesEl!,
      getFileContextManager: () => this.fileContextManager,
      updateQueueIndicator: () => this.inputController?.updateQueueIndicator(),
      setPlanModeActive: (_active) => {
        this.updatePlanModeUiState();
      },
    });

    // Conversation controller
    this.conversationController = new ConversationController(
      {
        plugin: this.plugin,
        agentService: this.agentService,
        state: this.state,
        renderer: this.renderer!,
        asyncSubagentManager: this.asyncSubagentManager,
        getHistoryDropdown: () => this.historyDropdown,
        getWelcomeEl: () => this.welcomeEl,
        setWelcomeEl: (el) => { this.welcomeEl = el; },
        getMessagesEl: () => this.messagesEl!,
        getInputEl: () => this.inputEl!,
        getFileContextManager: () => this.fileContextManager,
        getImageContextManager: () => this.imageContextManager,
        getMcpServerSelector: () => this.mcpServerSelector,
        getExternalContextSelector: () => this.externalContextSelector,
        clearQueuedMessage: () => this.inputController?.clearQueuedMessage(),
        getApprovedPlan: () => this.agentService.getApprovedPlanContent(),
        setApprovedPlan: (plan) => this.agentService.setApprovedPlanContent(plan),
        showPlanBanner: (content) => { void this.planBanner?.show(content); },
        hidePlanBanner: () => this.planBanner?.hide(),
        triggerPendingPlanApproval: (content) => this.inputController?.restorePendingPlanApproval(content),
        getTitleGenerationService: () => this.titleGenerationService,
        setPlanModeActive: (_active) => {
          this.updatePlanModeUiState();
        },
        getTodoPanel: () => this.todoPanel,
        getInitialConversationId: () => this.boundConversationId,
        onConversationBound: (id) => this.bindConversation(id),
        findOtherLeafBoundTo: (cid) => this.findOtherLeafBoundTo(cid),
      },
      {}
    );

    // Input controller
    this.inputController = new InputController({
      plugin: this.plugin,
      agentService: this.agentService,
      state: this.state,
      renderer: this.renderer!,
      streamController: this.streamController,
      selectionController: this.selectionController,
      conversationController: this.conversationController,
      getInputEl: () => this.inputEl!,
      getWelcomeEl: () => this.welcomeEl,
      getMessagesEl: () => this.messagesEl!,
      getFileContextManager: () => this.fileContextManager,
      getImageContextManager: () => this.imageContextManager,
      getSlashCommandManager: () => this.slashCommandManager,
      getMcpServerSelector: () => this.mcpServerSelector,
      getExternalContextSelector: () => this.externalContextSelector,
      getInstructionModeManager: () => this.instructionModeManager,
      getInstructionRefineService: () => this.instructionRefineService,
      getTitleGenerationService: () => this.titleGenerationService,
      getComponent: () => this,
      setPlanModeActive: (_active) => {
        this.updatePlanModeUiState();
      },
      getPlanBanner: () => this.planBanner,
      generateId: () => this.generateId(),
      resetContextMeter: () => this.contextUsageMeter?.update(null),
    });

    this.permissionToggle?.setOnPlanModeToggle((active) => {
      this.inputController?.setPlanModeRequested(active);
    });

    // Set approval callback
    this.agentService.setApprovalCallback(
      (toolName, input, description) => this.inputController!.handleApprovalRequest(toolName, input, description)
    );

    // Set AskUserQuestion callback
    this.agentService.setAskUserQuestionCallback(
      (input) => this.inputController!.handleAskUserQuestion(input)
    );

    // Set ExitPlanMode callback
    this.agentService.setExitPlanModeCallback(
      (planFilePath) => this.inputController!.handleExitPlanMode(planFilePath)
    );

    // Set EnterPlanMode callback
    this.agentService.setEnterPlanModeCallback(
      () => this.inputController!.handleEnterPlanMode()
    );

    // Navigation controller (vim-style keyboard navigation)
    this.navigationController = new NavigationController({
      getMessagesEl: () => this.messagesEl!,
      getInputEl: () => this.inputEl!,
      getSettings: () => this.plugin.settings.keyboardNavigation,
      isStreaming: () => this.state.isStreaming,
      shouldSkipEscapeHandling: () => {
        // Skip if instruction mode, slash dropdown, or mention dropdown is active
        if (this.instructionModeManager?.isActive()) return true;
        if (this.slashCommandDropdown?.isVisible()) return true;
        if (this.fileContextManager?.isMentionDropdownVisible()) return true;
        return false;
      },
    });
    this.navigationController.initialize();
  }

  // ============================================
  // Event Wiring
  // ============================================

  private wireEventHandlers() {
    // Document-level events
    this.registerDomEvent(document, 'click', () => {
      this.historyDropdown?.removeClass('visible');
    });

    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.state.isStreaming) {
        e.preventDefault();
        this.inputController?.cancelStreaming();
      }
    });

    // File context manager events
    this.registerEvent(this.plugin.app.vault.on('create', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('delete', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('rename', () => this.fileContextManager?.markFilesCacheDirty()));
    this.registerEvent(this.plugin.app.vault.on('modify', () => this.fileContextManager?.markFilesCacheDirty()));

    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file) {
          this.fileContextManager?.handleFileOpen(file);
        }
      })
    );

    this.registerDomEvent(document, 'click', (e) => {
      if (!this.fileContextManager?.containsElement(e.target as Node) && e.target !== this.inputEl) {
        this.fileContextManager?.hideMentionDropdown();
      }
    });

    // Shift+Tab: Toggle plan mode (capture phase for priority)
    this.inputEl!.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && e.shiftKey && !this.state.isStreaming) {
        e.preventDefault();
        e.stopPropagation();
        this.permissionToggle?.togglePlanMode();
      }
    }, { capture: true });

    // Input events
    this.inputEl!.addEventListener('keydown', (e) => {
      // Check for # trigger first (empty input + # keystroke)
      if (this.instructionModeManager?.handleTriggerKey(e)) {
        return;
      }

      if (this.instructionModeManager?.handleKeydown(e)) {
        return;
      }

      if (this.slashCommandDropdown?.handleKeydown(e)) {
        return;
      }

      if (this.fileContextManager?.handleMentionKeydown(e)) {
        return;
      }

      if (e.key === 'Escape' && this.state.isStreaming) {
        e.preventDefault();
        this.inputController?.cancelStreaming();
        return;
      }

      // Enter: Send message (plan mode if active, normal otherwise)
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (this.permissionToggle?.isPlanModeActive()) {
          void this.inputController?.sendPlanModeMessage();
        } else {
          void this.inputController?.sendMessage();
        }
      }
    });

    this.inputEl!.addEventListener('input', () => {
      this.fileContextManager?.handleInputChange();
      this.instructionModeManager?.handleInputChange();
    });

    this.inputEl!.addEventListener('focus', () => {
      this.selectionController?.showHighlight();
    });
  }

  // ============================================
  // Utilities
  // ============================================

  private generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private updatePlanModeUiState(): void {
    const isPlanMode = this.plugin.settings.permissionMode === 'plan';
    const isPlanModeRequested = this.state.planModeRequested;
    this.permissionToggle?.setPlanModeActive(isPlanMode || isPlanModeRequested);
  }

}
