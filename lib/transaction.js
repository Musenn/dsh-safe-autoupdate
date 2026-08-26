export async function applyTransaction({ fromVersion, targetVersion, install, verify }) {
  const installed = await install(targetVersion);
  if (!installed.ok) {
    const oldState = await verify(fromVersion);
    if (oldState.ok) return { phase: "failed", from: fromVersion, to: targetVersion, error: installed.error };
    const restored = await install(fromVersion);
    const verified = restored.ok ? await verify(fromVersion) : { ok: false };
    return {
      phase: "rolled-back",
      from: fromVersion,
      to: targetVersion,
      error: installed.error,
      rollbackVerified: verified.ok === true,
    };
  }

  const targetState = await verify(targetVersion);
  if (targetState.ok) return { phase: "done", from: fromVersion, to: targetVersion };

  const restored = await install(fromVersion);
  const verified = restored.ok ? await verify(fromVersion) : { ok: false };
  return {
    phase: "rolled-back",
    from: fromVersion,
    to: targetVersion,
    error: targetState.reason || "verification-failed",
    rollbackVerified: verified.ok === true,
  };
}
