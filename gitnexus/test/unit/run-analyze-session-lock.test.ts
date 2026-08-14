import { describe, expect, it, vi } from 'vitest';

const {
  runPipelineFromRepoMock,
  initLbugMock,
  loadGraphToLbugMock,
  getLbugStatsMock,
  executeQueryMock,
  executeWithReusedStatementMock,
  closeLbugMock,
  loadCachedEmbeddingsMock,
  createSearchFTSIndexesMock,
  getStoragePathsMock,
  saveMetaMock,
  loadMetaMock,
  ensureGitNexusIgnoredMock,
  registerRepoMock,
  cleanupOldKuzuFilesMock,
  cleanupLbugArtifactsMock,
  cleanupTempLbugArtifactsMock,
  clearAnalysisIncompleteMarkerMock,
  createAnalysisIncompleteMarkerMock,
  createTempLbugPathMock,
  promoteLbugDatabaseMock,
  getIndexHealthMock,
  withAnalysisLockMock,
  getCurrentCommitMock,
  getRemoteUrlMock,
  hasGitDirMock,
  getInferredRepoNameMock,
  generateAIContextFilesMock,
  getRuntimeCapabilitiesMock,
} = vi.hoisted(() => ({
  runPipelineFromRepoMock: vi.fn(),
  initLbugMock: vi.fn(),
  loadGraphToLbugMock: vi.fn(),
  getLbugStatsMock: vi.fn(),
  executeQueryMock: vi.fn(),
  executeWithReusedStatementMock: vi.fn(),
  closeLbugMock: vi.fn(),
  loadCachedEmbeddingsMock: vi.fn(),
  createSearchFTSIndexesMock: vi.fn(),
  getStoragePathsMock: vi.fn(),
  saveMetaMock: vi.fn(),
  loadMetaMock: vi.fn(),
  ensureGitNexusIgnoredMock: vi.fn(),
  registerRepoMock: vi.fn(),
  cleanupOldKuzuFilesMock: vi.fn(),
  cleanupLbugArtifactsMock: vi.fn(),
  cleanupTempLbugArtifactsMock: vi.fn(),
  clearAnalysisIncompleteMarkerMock: vi.fn(),
  createAnalysisIncompleteMarkerMock: vi.fn(),
  createTempLbugPathMock: vi.fn(),
  promoteLbugDatabaseMock: vi.fn(),
  getIndexHealthMock: vi.fn(),
  withAnalysisLockMock: vi.fn(),
  getCurrentCommitMock: vi.fn(),
  getRemoteUrlMock: vi.fn(),
  hasGitDirMock: vi.fn(),
  getInferredRepoNameMock: vi.fn(),
  generateAIContextFilesMock: vi.fn(),
  getRuntimeCapabilitiesMock: vi.fn(),
}));

vi.mock('../../src/core/ingestion/pipeline.js', () => ({
  runPipelineFromRepo: runPipelineFromRepoMock,
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  initLbug: initLbugMock,
  loadGraphToLbug: loadGraphToLbugMock,
  getLbugStats: getLbugStatsMock,
  executeQuery: executeQueryMock,
  executeWithReusedStatement: executeWithReusedStatementMock,
  closeLbug: closeLbugMock,
  loadCachedEmbeddings: loadCachedEmbeddingsMock,
}));

vi.mock('../../src/core/search/fts-indexes.js', () => ({
  createSearchFTSIndexes: createSearchFTSIndexesMock,
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: getStoragePathsMock,
  saveMeta: saveMetaMock,
  loadMeta: loadMetaMock,
  ensureGitNexusIgnored: ensureGitNexusIgnoredMock,
  registerRepo: registerRepoMock,
  cleanupOldKuzuFiles: cleanupOldKuzuFilesMock,
  cleanupLbugArtifacts: cleanupLbugArtifactsMock,
  cleanupTempLbugArtifacts: cleanupTempLbugArtifactsMock,
  clearAnalysisIncompleteMarker: clearAnalysisIncompleteMarkerMock,
  createAnalysisIncompleteMarker: createAnalysisIncompleteMarkerMock,
  createTempLbugPath: createTempLbugPathMock,
  promoteLbugDatabase: promoteLbugDatabaseMock,
  getIndexHealth: getIndexHealthMock,
  withAnalysisLock: withAnalysisLockMock,
}));

vi.mock('../../src/storage/git.js', () => ({
  getCurrentCommit: getCurrentCommitMock,
  getRemoteUrl: getRemoteUrlMock,
  hasGitDir: hasGitDirMock,
  getInferredRepoName: getInferredRepoNameMock,
}));

vi.mock('../../src/cli/ai-context.js', () => ({
  generateAIContextFiles: generateAIContextFilesMock,
}));

vi.mock('../../src/core/lbug/schema.js', () => ({
  EMBEDDING_TABLE_NAME: 'Embedding',
  STALE_HASH_SENTINEL: 'stale',
  EMBEDDING_DIMS: 768,
}));

vi.mock('../../src/core/platform/capabilities.js', () => ({
  getRuntimeCapabilities: getRuntimeCapabilitiesMock,
}));

describe('runFullAnalysis process-local LadybugDB session', () => {
  it('serializes native lifecycle phases for independent worktree locks', async () => {
    vi.clearAllMocks();

    const firstWorktree = '/worktrees/one';
    const secondWorktree = '/worktrees/two';
    const openedNativePaths: string[] = [];
    let nativeSessionOpen = false;
    let maxConcurrentNativeSessions = 0;
    let resolveFirstNativeInit!: () => void;
    let releaseFirstNativeInit!: () => void;
    const firstNativeInit = new Promise<void>((resolve) => {
      resolveFirstNativeInit = resolve;
    });
    const allowFirstNativeInitToFinish = new Promise<void>((resolve) => {
      releaseFirstNativeInit = resolve;
    });

    // Model distinct cross-process/worktree locks: both callbacks can start
    // immediately, leaving the process-local analysis session as the only
    // serialization point under test.
    withAnalysisLockMock.mockImplementation(
      async (_repoPath: string, callback: () => Promise<unknown>) => callback(),
    );
    getStoragePathsMock.mockImplementation((repoPath: string) => ({
      storagePath: `${repoPath}/.gitnexus`,
      lbugPath: `${repoPath}/.gitnexus/lbug`,
    }));
    createTempLbugPathMock.mockImplementation((storagePath: string) => `${storagePath}/lbug.tmp`);
    cleanupOldKuzuFilesMock.mockResolvedValue({ found: false, needsReindex: false });
    loadMetaMock.mockResolvedValue(undefined);
    getIndexHealthMock.mockResolvedValue(undefined);
    hasGitDirMock.mockReturnValue(false);
    getInferredRepoNameMock.mockImplementation((repoPath: string) =>
      repoPath.split('/').filter(Boolean).at(-1),
    );
    runPipelineFromRepoMock.mockImplementation(async (repoPath: string) => ({
      graph: {},
      repoPath,
      totalFileCount: 1,
    }));
    loadGraphToLbugMock.mockResolvedValue(undefined);
    createSearchFTSIndexesMock.mockResolvedValue(undefined);
    getLbugStatsMock.mockResolvedValue({ nodes: 0, edges: 0 });
    executeQueryMock.mockResolvedValue([]);
    getRuntimeCapabilitiesMock.mockReturnValue({
      graph: 'available',
      fts: 'available',
      semanticMode: 'exact-scan',
      exactScanLimit: 1_000,
    });
    registerRepoMock.mockImplementation(async (repoPath: string) =>
      repoPath.split('/').filter(Boolean).at(-1),
    );
    ensureGitNexusIgnoredMock.mockResolvedValue(undefined);
    saveMetaMock.mockResolvedValue(undefined);
    cleanupLbugArtifactsMock.mockResolvedValue(undefined);
    cleanupTempLbugArtifactsMock.mockResolvedValue(undefined);
    createAnalysisIncompleteMarkerMock.mockResolvedValue(undefined);
    clearAnalysisIncompleteMarkerMock.mockResolvedValue(undefined);
    promoteLbugDatabaseMock.mockResolvedValue(undefined);
    closeLbugMock.mockImplementation(async () => {
      nativeSessionOpen = false;
    });
    initLbugMock.mockImplementation(async (dbPath: string) => {
      // If the queue regresses, the second worktree reaches this point while
      // the first still owns the module-level LadybugDB session.
      expect(nativeSessionOpen).toBe(false);
      nativeSessionOpen = true;
      maxConcurrentNativeSessions = Math.max(maxConcurrentNativeSessions, 1);
      openedNativePaths.push(dbPath);
      if (dbPath.startsWith(firstWorktree)) {
        resolveFirstNativeInit();
        await allowFirstNativeInitToFinish;
      }
    });

    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    const callbacks = { onProgress: () => {} };
    const first = runFullAnalysis(firstWorktree, { indexOnly: true, skipWorkers: true }, callbacks);
    await firstNativeInit;

    const second = runFullAnalysis(secondWorktree, { indexOnly: true }, callbacks);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The second worktree acquired its own filesystem lock, but has not
    // entered the native phase before the first worktree fully closes it.
    expect(initLbugMock).toHaveBeenCalledTimes(1);
    expect(nativeSessionOpen).toBe(true);

    releaseFirstNativeInit();
    await Promise.all([first, second]);

    // Automatic refreshers opt into sequential parsing explicitly. The
    // regular analyze path keeps its existing worker-pool default by passing
    // no pipeline override at all.
    expect(runPipelineFromRepoMock).toHaveBeenNthCalledWith(
      1,
      firstWorktree,
      expect.any(Function),
      { skipWorkers: true },
    );
    expect(runPipelineFromRepoMock).toHaveBeenNthCalledWith(
      2,
      secondWorktree,
      expect.any(Function),
      undefined,
    );

    // The coordinator's extension-install boundary must cover both writable
    // LadybugDB lifecycles: an existing index opened to preserve embeddings
    // and the temporary database that receives the rebuilt graph. This test
    // has no existing metadata, so it observes the latter directly.
    expect(initLbugMock).toHaveBeenNthCalledWith(
      1,
      `${firstWorktree}/.gitnexus/lbug.tmp`,
      undefined,
    );
    expect(initLbugMock).toHaveBeenNthCalledWith(
      2,
      `${secondWorktree}/.gitnexus/lbug.tmp`,
      undefined,
    );

    expect(openedNativePaths).toEqual([
      `${firstWorktree}/.gitnexus/lbug.tmp`,
      `${secondWorktree}/.gitnexus/lbug.tmp`,
    ]);
    expect(maxConcurrentNativeSessions).toBe(1);
    expect(nativeSessionOpen).toBe(false);
  });

  it('passes load-only to both cached and temporary LadybugDB opens for a coordinator refresh', async () => {
    vi.clearAllMocks();

    const worktree = '/worktrees/coordinator';
    withAnalysisLockMock.mockImplementation(
      async (_repoPath: string, callback: () => Promise<unknown>) => callback(),
    );
    getStoragePathsMock.mockReturnValue({
      storagePath: `${worktree}/.gitnexus`,
      lbugPath: `${worktree}/.gitnexus/lbug`,
    });
    createTempLbugPathMock.mockReturnValue(`${worktree}/.gitnexus/lbug.tmp`);
    cleanupOldKuzuFilesMock.mockResolvedValue({ found: false, needsReindex: false });
    loadMetaMock.mockResolvedValue({
      repoPath: worktree,
      lastCommit: 'old-commit',
      stats: { embeddings: 1 },
    });
    getIndexHealthMock.mockResolvedValue({ ok: true });
    hasGitDirMock.mockReturnValue(true);
    getCurrentCommitMock.mockReturnValue('new-commit');
    getInferredRepoNameMock.mockReturnValue('coordinator');
    runPipelineFromRepoMock.mockResolvedValue({ graph: {}, repoPath: worktree, totalFileCount: 1 });
    loadCachedEmbeddingsMock.mockResolvedValue({ embeddingNodeIds: new Set(), embeddings: [] });
    loadGraphToLbugMock.mockResolvedValue(undefined);
    createSearchFTSIndexesMock.mockResolvedValue(undefined);
    getLbugStatsMock.mockResolvedValue({ nodes: 0, edges: 0 });
    executeQueryMock.mockResolvedValue([]);
    getRuntimeCapabilitiesMock.mockReturnValue({
      graph: 'available',
      fts: 'unavailable',
      semanticMode: 'exact-scan',
      exactScanLimit: 1_000,
    });
    registerRepoMock.mockResolvedValue('coordinator');
    ensureGitNexusIgnoredMock.mockResolvedValue(undefined);
    saveMetaMock.mockResolvedValue(undefined);
    cleanupLbugArtifactsMock.mockResolvedValue(undefined);
    cleanupTempLbugArtifactsMock.mockResolvedValue(undefined);
    createAnalysisIncompleteMarkerMock.mockResolvedValue(undefined);
    clearAnalysisIncompleteMarkerMock.mockResolvedValue(undefined);
    promoteLbugDatabaseMock.mockResolvedValue(undefined);
    closeLbugMock.mockResolvedValue(undefined);
    initLbugMock.mockResolvedValue(undefined);

    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await runFullAnalysis(
      worktree,
      { force: true, suppressEmbeddingGeneration: true, extensionInstallPolicy: 'load-only' },
      { onProgress: () => {} },
    );

    expect(initLbugMock).toHaveBeenNthCalledWith(1, `${worktree}/.gitnexus/lbug`, {
      extensionInstallPolicy: 'load-only',
    });
    expect(initLbugMock).toHaveBeenNthCalledWith(2, `${worktree}/.gitnexus/lbug.tmp`, {
      extensionInstallPolicy: 'load-only',
    });
  });
});
