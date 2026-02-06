import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  ConversationItem,
  CustomPromptOption,
  DebugEntry,
  ThreadHistorySnapshot,
  ThreadSummary,
  WorkspaceInfo,
} from "../../../types";
import { useAppServerEvents } from "../../app/hooks/useAppServerEvents";
import { initialState, threadReducer } from "./useThreadsReducer";
import { useThreadStorage } from "./useThreadStorage";
import { useThreadLinking } from "./useThreadLinking";
import { useThreadEventHandlers } from "./useThreadEventHandlers";
import { useThreadActions } from "./useThreadActions";
import { useThreadMessaging } from "./useThreadMessaging";
import { useThreadApprovals } from "./useThreadApprovals";
import { useThreadAccountInfo } from "./useThreadAccountInfo";
import { useThreadRateLimits } from "./useThreadRateLimits";
import { useThreadSelectors } from "./useThreadSelectors";
import { useThreadStatus } from "./useThreadStatus";
import { useThreadUserInput } from "./useThreadUserInput";
import {
  loadThreadHistory,
  saveThreadHistory,
  setThreadName as setThreadNameService,
} from "../../../services/tauri";
import { makeCustomNameKey, saveCustomName } from "../utils/threadStorage";

type UseThreadsOptions = {
  activeWorkspace: WorkspaceInfo | null;
  onWorkspaceConnected: (id: string) => void;
  onDebug?: (entry: DebugEntry) => void;
  model?: string | null;
  effort?: string | null;
  collaborationMode?: Record<string, unknown> | null;
  accessMode?: "read-only" | "current" | "full-access";
  reviewDeliveryMode?: "inline" | "detached";
  steerEnabled?: boolean;
  customPrompts?: CustomPromptOption[];
  onMessageActivity?: () => void;
};

export function useThreads({
  activeWorkspace,
  onWorkspaceConnected,
  onDebug,
  model,
  effort,
  collaborationMode,
  accessMode,
  reviewDeliveryMode = "inline",
  steerEnabled = false,
  customPrompts = [],
  onMessageActivity,
}: UseThreadsOptions) {
  const [state, dispatch] = useReducer(threadReducer, initialState);
  const loadedThreadsRef = useRef<Record<string, boolean>>({});
  const replaceOnResumeRef = useRef<Record<string, boolean>>({});
  const pendingInterruptsRef = useRef<Set<string>>(new Set());
  const planByThreadRef = useRef(state.planByThread);
  const detachedReviewNoticeRef = useRef<Set<string>>(new Set());
  planByThreadRef.current = state.planByThread;
  const { approvalAllowlistRef, handleApprovalDecision, handleApprovalRemember } =
    useThreadApprovals({ dispatch, onDebug });
  const { handleUserInputSubmit } = useThreadUserInput({ dispatch });
  const {
    customNamesRef,
    threadActivityRef,
    pinnedThreadsVersion,
    getCustomName,
    recordThreadActivity,
    pinThread,
    unpinThread,
    isThreadPinned,
    getPinTimestamp,
  } = useThreadStorage();
  void pinnedThreadsVersion;
  const historyLoadedRef = useRef<Record<string, boolean>>({});
  const lastSavedHistoryRef = useRef<Record<string, string>>({});
  const historySaveTimerRef = useRef<number | null>(null);

  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const { activeThreadId, activeItems } = useThreadSelectors({
    activeWorkspaceId,
    activeThreadIdByWorkspace: state.activeThreadIdByWorkspace,
    itemsByThread: state.itemsByThread,
  });

  const applyThreadHistory = useCallback(
    (workspaceId: string, snapshot: ThreadHistorySnapshot) => {
      const persistedThreads = Array.isArray(snapshot.threads)
        ? (snapshot.threads as ThreadSummary[])
        : [];
      const itemsByThread = snapshot.itemsByThread ?? {};
      const existingThreads = state.threadsByWorkspace[workspaceId] ?? [];
      const existingIds = new Set(existingThreads.map((thread) => thread.id));
      const additions = persistedThreads.filter(
        (thread) => thread?.id && !existingIds.has(thread.id),
      );
      const mergedThreads = [...existingThreads, ...additions].sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      );
      if (mergedThreads.length > 0 && additions.length > 0) {
        dispatch({ type: "setThreads", workspaceId, threads: mergedThreads });
      } else if (existingThreads.length === 0 && mergedThreads.length > 0) {
        dispatch({ type: "setThreads", workspaceId, threads: mergedThreads });
      }
      mergedThreads.forEach((thread) => {
        const items = itemsByThread[thread.id];
        if (!Array.isArray(items) || items.length === 0) {
          return;
        }
        const existingItems = state.itemsByThread[thread.id] ?? [];
        if (existingItems.length === 0) {
          dispatch({ type: "setThreadItems", threadId: thread.id, items });
        }
        const lastAgent = [...items]
          .reverse()
          .find(
            (item: ConversationItem) =>
              item.kind === "message" && item.role === "assistant",
          );
        if (lastAgent && lastAgent.kind === "message") {
          dispatch({
            type: "setLastAgentMessage",
            threadId: thread.id,
            text: lastAgent.text,
            timestamp: thread.updatedAt ?? Date.now(),
          });
        }
        loadedThreadsRef.current[thread.id] = true;
      });
      const parents = snapshot.threadParentById ?? {};
      Object.entries(parents).forEach(([threadId, parentId]) => {
        if (typeof parentId === "string" && parentId) {
          dispatch({ type: "setThreadParent", threadId, parentId });
        }
      });
      if (
        snapshot.activeThreadId &&
        !state.activeThreadIdByWorkspace[workspaceId]
      ) {
        dispatch({
          type: "setActiveThreadId",
          workspaceId,
          threadId: snapshot.activeThreadId,
        });
      }
    },
    [dispatch, loadedThreadsRef, state.activeThreadIdByWorkspace, state.itemsByThread, state.threadsByWorkspace],
  );

  const buildThreadHistorySnapshot = useCallback(
    (workspaceId: string): ThreadHistorySnapshot => {
      const threads = state.threadsByWorkspace[workspaceId] ?? [];
      const itemsByThread: Record<string, ConversationItem[]> = {};
      const threadParentById: Record<string, string> = {};
      threads.forEach((thread) => {
        const items = state.itemsByThread[thread.id];
        if (items && items.length > 0) {
          itemsByThread[thread.id] = items;
        }
        const parentId = state.threadParentById[thread.id];
        if (parentId) {
          threadParentById[thread.id] = parentId;
        }
      });
      return {
        version: 1,
        workspaceId,
        activeThreadId: state.activeThreadIdByWorkspace[workspaceId] ?? null,
        threads,
        itemsByThread,
        threadParentById,
        savedAt: Date.now(),
      };
    },
    [
      state.activeThreadIdByWorkspace,
      state.itemsByThread,
      state.threadParentById,
      state.threadsByWorkspace,
    ],
  );

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    if (historyLoadedRef.current[activeWorkspaceId]) {
      return;
    }
    historyLoadedRef.current[activeWorkspaceId] = true;
    void (async () => {
      try {
        const snapshot = await loadThreadHistory(activeWorkspaceId);
        if (snapshot) {
          applyThreadHistory(activeWorkspaceId, snapshot);
        }
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-history-load-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/history load error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [activeWorkspaceId, applyThreadHistory, onDebug]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const workspaceIds = new Set<string>([
      ...Object.keys(state.threadsByWorkspace),
      ...Object.keys(state.activeThreadIdByWorkspace),
    ]);
    if (workspaceIds.size === 0) {
      return;
    }
    if (historySaveTimerRef.current) {
      window.clearTimeout(historySaveTimerRef.current);
    }
    historySaveTimerRef.current = window.setTimeout(() => {
      workspaceIds.forEach((workspaceId) => {
        const snapshot = buildThreadHistorySnapshot(workspaceId);
        const serialized = JSON.stringify(snapshot);
        if (lastSavedHistoryRef.current[workspaceId] === serialized) {
          return;
        }
        lastSavedHistoryRef.current[workspaceId] = serialized;
        void saveThreadHistory(workspaceId, snapshot).catch((error) => {
          onDebug?.({
            id: `${Date.now()}-client-thread-history-save-error`,
            timestamp: Date.now(),
            source: "error",
            label: "thread/history save error",
            payload: error instanceof Error ? error.message : String(error),
          });
        });
      });
    }, 750);
    return () => {
      if (historySaveTimerRef.current) {
        window.clearTimeout(historySaveTimerRef.current);
      }
    };
  }, [
    buildThreadHistorySnapshot,
    onDebug,
    state.activeThreadIdByWorkspace,
    state.threadsByWorkspace,
  ]);

  const { refreshAccountRateLimits } = useThreadRateLimits({
    activeWorkspaceId,
    activeWorkspaceConnected: activeWorkspace?.connected,
    dispatch,
    onDebug,
  });
  const { refreshAccountInfo } = useThreadAccountInfo({
    activeWorkspaceId,
    activeWorkspaceConnected: activeWorkspace?.connected,
    dispatch,
    onDebug,
  });

  const { markProcessing, markReviewing, setActiveTurnId } = useThreadStatus({
    dispatch,
  });

  const pushThreadErrorMessage = useCallback(
    (threadId: string, message: string) => {
      dispatch({
        type: "addAssistantMessage",
        threadId,
        text: message,
      });
      if (threadId !== activeThreadId) {
        dispatch({ type: "markUnread", threadId, hasUnread: true });
      }
    },
    [activeThreadId, dispatch],
  );

  const safeMessageActivity = useCallback(() => {
    try {
      void onMessageActivity?.();
    } catch {
      // Ignore refresh errors to avoid breaking the UI.
    }
  }, [onMessageActivity]);
  const { applyCollabThreadLinks, applyCollabThreadLinksFromThread, updateThreadParent } =
    useThreadLinking({
      dispatch,
      threadParentById: state.threadParentById,
    });

  const handleWorkspaceConnected = useCallback(
    (workspaceId: string) => {
      onWorkspaceConnected(workspaceId);
      void refreshAccountRateLimits(workspaceId);
      void refreshAccountInfo(workspaceId);
    },
    [onWorkspaceConnected, refreshAccountRateLimits, refreshAccountInfo],
  );

  const handleAccountUpdated = useCallback(
    (workspaceId: string) => {
      void refreshAccountRateLimits(workspaceId);
      void refreshAccountInfo(workspaceId);
    },
    [refreshAccountRateLimits, refreshAccountInfo],
  );

  const isThreadHidden = useCallback(
    (workspaceId: string, threadId: string) =>
      Boolean(state.hiddenThreadIdsByWorkspace[workspaceId]?.[threadId]),
    [state.hiddenThreadIdsByWorkspace],
  );

  const handleReviewExited = useCallback(
    (workspaceId: string, threadId: string) => {
      const parentId = state.threadParentById[threadId];
      if (!parentId || parentId === threadId) {
        return;
      }
      const parentStatus = state.threadStatusById[parentId];
      if (!parentStatus?.isReviewing) {
        return;
      }

      markReviewing(parentId, false);
      markProcessing(parentId, false);
      setActiveTurnId(parentId, null);

      const timestamp = Date.now();
      recordThreadActivity(workspaceId, parentId, timestamp);
      dispatch({
        type: "setThreadTimestamp",
        workspaceId,
        threadId: parentId,
        timestamp,
      });
      const noticeKey = `${parentId}->${threadId}`;
      const alreadyNotified = detachedReviewNoticeRef.current.has(noticeKey);
      if (!alreadyNotified) {
        detachedReviewNoticeRef.current.add(noticeKey);
        dispatch({
          type: "addAssistantMessage",
          threadId: parentId,
          text: `Detached review completed. [Open review thread](/thread/${threadId})`,
        });
      }
      if (parentId !== activeThreadId) {
        dispatch({ type: "markUnread", threadId: parentId, hasUnread: true });
      }
      safeMessageActivity();
    },
    [
      activeThreadId,
      dispatch,
      markProcessing,
      markReviewing,
      recordThreadActivity,
      safeMessageActivity,
      setActiveTurnId,
      state.threadParentById,
      state.threadStatusById,
    ],
  );

  const threadHandlers = useThreadEventHandlers({
    activeThreadId,
    dispatch,
    planByThreadRef,
    getCustomName,
    isThreadHidden,
    markProcessing,
    markReviewing,
    setActiveTurnId,
    safeMessageActivity,
    recordThreadActivity,
    pushThreadErrorMessage,
    onDebug,
    onWorkspaceConnected: handleWorkspaceConnected,
    applyCollabThreadLinks,
    onReviewExited: handleReviewExited,
    approvalAllowlistRef,
    pendingInterruptsRef,
  });

  const handleAccountLoginCompleted = useCallback(
    (workspaceId: string) => {
      handleAccountUpdated(workspaceId);
    },
    [handleAccountUpdated],
  );

  const handlers = useMemo(
    () => ({
      ...threadHandlers,
      onAccountUpdated: handleAccountUpdated,
      onAccountLoginCompleted: handleAccountLoginCompleted,
    }),
    [threadHandlers, handleAccountUpdated, handleAccountLoginCompleted],
  );

  useAppServerEvents(handlers);

  const {
    startThreadForWorkspace,
    forkThreadForWorkspace,
    resumeThreadForWorkspace,
    refreshThread,
    resetWorkspaceThreads,
    listThreadsForWorkspace,
    loadOlderThreadsForWorkspace,
    archiveThread,
  } = useThreadActions({
    dispatch,
    itemsByThread: state.itemsByThread,
    threadsByWorkspace: state.threadsByWorkspace,
    activeThreadIdByWorkspace: state.activeThreadIdByWorkspace,
    threadListCursorByWorkspace: state.threadListCursorByWorkspace,
    threadStatusById: state.threadStatusById,
    onDebug,
    getCustomName,
    threadActivityRef,
    loadedThreadsRef,
    replaceOnResumeRef,
    applyCollabThreadLinksFromThread,
  });

  const startThread = useCallback(async () => {
    if (!activeWorkspaceId) {
      return null;
    }
    return startThreadForWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId, startThreadForWorkspace]);

  const ensureThreadForActiveWorkspace = useCallback(async () => {
    if (!activeWorkspace) {
      return null;
    }
    let threadId = activeThreadId;
    if (!threadId) {
      threadId = await startThreadForWorkspace(activeWorkspace.id);
      if (!threadId) {
        return null;
      }
    } else if (!loadedThreadsRef.current[threadId]) {
      await resumeThreadForWorkspace(activeWorkspace.id, threadId);
    }
    return threadId;
  }, [activeWorkspace, activeThreadId, resumeThreadForWorkspace, startThreadForWorkspace]);

  const ensureThreadForWorkspace = useCallback(
    async (workspaceId: string) => {
      const currentActiveThreadId = state.activeThreadIdByWorkspace[workspaceId] ?? null;
      const shouldActivate = workspaceId === activeWorkspaceId;
      let threadId = currentActiveThreadId;
      if (!threadId) {
        threadId = await startThreadForWorkspace(workspaceId, {
          activate: shouldActivate,
        });
        if (!threadId) {
          return null;
        }
      } else if (!loadedThreadsRef.current[threadId]) {
        await resumeThreadForWorkspace(workspaceId, threadId);
      }
      if (shouldActivate && currentActiveThreadId !== threadId) {
        dispatch({ type: "setActiveThreadId", workspaceId, threadId });
      }
      return threadId;
    },
    [
      activeWorkspaceId,
      dispatch,
      loadedThreadsRef,
      resumeThreadForWorkspace,
      startThreadForWorkspace,
      state.activeThreadIdByWorkspace,
    ],
  );

  const {
    interruptTurn,
    sendUserMessage,
    sendUserMessageToThread,
    startFork,
    startReview,
    startResume,
    startCompact,
    startApps,
    startMcp,
    startStatus,
    reviewPrompt,
    openReviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
  } = useThreadMessaging({
    activeWorkspace,
    activeThreadId,
    accessMode,
    model,
    effort,
    collaborationMode,
    reviewDeliveryMode,
    steerEnabled,
    customPrompts,
    threadStatusById: state.threadStatusById,
    activeTurnIdByThread: state.activeTurnIdByThread,
    rateLimitsByWorkspace: state.rateLimitsByWorkspace,
    pendingInterruptsRef,
    dispatch,
    getCustomName,
    markProcessing,
    markReviewing,
    setActiveTurnId,
    recordThreadActivity,
    safeMessageActivity,
    onDebug,
    pushThreadErrorMessage,
    ensureThreadForActiveWorkspace,
    ensureThreadForWorkspace,
    refreshThread,
    forkThreadForWorkspace,
    updateThreadParent,
  });

  const setActiveThreadId = useCallback(
    (threadId: string | null, workspaceId?: string) => {
      const targetId = workspaceId ?? activeWorkspaceId;
      if (!targetId) {
        return;
      }
      dispatch({ type: "setActiveThreadId", workspaceId: targetId, threadId });
      if (threadId) {
        void resumeThreadForWorkspace(targetId, threadId);
      }
    },
    [activeWorkspaceId, resumeThreadForWorkspace],
  );

  const removeThread = useCallback(
    (workspaceId: string, threadId: string) => {
      unpinThread(workspaceId, threadId);
      dispatch({ type: "removeThread", workspaceId, threadId });
      void archiveThread(workspaceId, threadId);
    },
    [archiveThread, unpinThread],
  );

  const renameThread = useCallback(
    (workspaceId: string, threadId: string, newName: string) => {
      saveCustomName(workspaceId, threadId, newName);
      const key = makeCustomNameKey(workspaceId, threadId);
      customNamesRef.current[key] = newName;
      dispatch({ type: "setThreadName", workspaceId, threadId, name: newName });
      void Promise.resolve(
        setThreadNameService(workspaceId, threadId, newName),
      ).catch((error) => {
        onDebug?.({
          id: `${Date.now()}-client-thread-rename-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/name/set error",
          payload: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [customNamesRef, dispatch, onDebug],
  );

  return {
    activeThreadId,
    setActiveThreadId,
    activeItems,
    approvals: state.approvals,
    userInputRequests: state.userInputRequests,
    threadsByWorkspace: state.threadsByWorkspace,
    threadParentById: state.threadParentById,
    threadStatusById: state.threadStatusById,
    threadResumeLoadingById: state.threadResumeLoadingById,
    threadListLoadingByWorkspace: state.threadListLoadingByWorkspace,
    threadListPagingByWorkspace: state.threadListPagingByWorkspace,
    threadListCursorByWorkspace: state.threadListCursorByWorkspace,
    activeTurnIdByThread: state.activeTurnIdByThread,
    tokenUsageByThread: state.tokenUsageByThread,
    rateLimitsByWorkspace: state.rateLimitsByWorkspace,
    accountByWorkspace: state.accountByWorkspace,
    planByThread: state.planByThread,
    lastAgentMessageByThread: state.lastAgentMessageByThread,
    refreshAccountRateLimits,
    refreshAccountInfo,
    interruptTurn,
    removeThread,
    pinThread,
    unpinThread,
    isThreadPinned,
    getPinTimestamp,
    renameThread,
    startThread,
    startThreadForWorkspace,
    forkThreadForWorkspace,
    listThreadsForWorkspace,
    refreshThread,
    resetWorkspaceThreads,
    loadOlderThreadsForWorkspace,
    sendUserMessage,
    sendUserMessageToThread,
    startFork,
    startReview,
    startResume,
    startCompact,
    startApps,
    startMcp,
    startStatus,
    reviewPrompt,
    openReviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
    handleApprovalDecision,
    handleApprovalRemember,
    handleUserInputSubmit,
  };
}
