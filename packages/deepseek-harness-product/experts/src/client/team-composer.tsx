import type { ExpertClientState } from './client-state.ts'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import React from 'react';
import { teamHasPinnedMembers, type ExpertTeam, type TeamSnapshot } from '../team-contract.ts';
import { TeamDetails, unwrap, type TeamRemote } from './team-ui.tsx';
import { TeamAvatars, TeamConfirm, teamIssue, IconEye } from './team-shared.tsx';
import { Button, Input } from './plugin-ui.ts';
import { useTeamDirectoryView } from './team-directory.ts';
import { focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives';
import { useLibraryRemovalFocus } from './library-ui.tsx';
/** 对话中的专家团选择；后台移除聚焦条目时返回搜索，不抢占其他控件。 */
export function TeamMenu(props: {
    cache: ExpertClientState;
    remote: TeamRemote;
    prepareSelect?(): (team: ExpertTeam, example?: string) => boolean | Promise<boolean>;
    onSelected(): void;
}) {
    const feedbackRef = React.useRef<HTMLDivElement>(null);
    const searchRef = React.useRef<HTMLInputElement>(null);
    const [focused, setFocused] = React.useState<{ id: string; action: 'choice' | 'details' } | null>(null);
    const choiceFocus = useLibraryRemovalFocus(() => searchRef.current);
    const { locale, tx, error, setError, directory, snapshot, experts } = useTeamDirectoryView({
        cache: props.cache, remote: props.remote, fallback: "专家团加载失败",
        onRefreshSuccess: () => {
            const feedback = feedbackRef.current;
            const search = searchRef.current;
            if (feedback?.contains(feedback.ownerDocument.activeElement) && search) {
                focusWithoutRing(search, { preventScroll: true });
            }
        },
    });
    const [query, setQuery] = React.useState('');
    const operation = React.useRef<AbortSignal | null>(null);
    const [pending, setPending] = React.useState<{ signal: AbortSignal; teamId: string; example?: string } | null>(null);
    const busy = pending !== null && !pending.signal.aborted;
    const [detailId, setDetailId] = React.useState<string | null>(null);
    const detail = snapshot?.teams.find(team => team.id === detailId) ?? null;
    const [confirm, setConfirm] = React.useState<{
        team: ExpertTeam;
        example?: string;
        snapshot: TeamSnapshot;
    } | null>(null);
    React.useEffect(() => {
        setPending(null);
        setDetailId(null);
        setConfirm(null);
        // The shared directory hook owns subscriptions and request cancellation.
    }, [props.remote, props.cache]);
    React.useEffect(() => {
        if (detailId !== null && !detail) setDetailId(null);
        if (!snapshot) {
            setConfirm(null);
        }
    }, [snapshot, detailId, detail]);
    const pick = async (team: ExpertTeam, example?: string, reviewed?: TeamSnapshot) => {
        const signal = directory.getSignal();
        if ((operation.current && !operation.current.aborted) || !snapshot || !signal || signal.aborted)
            return;
        if (reviewed && (reviewed.revision !== snapshot.revision
            || !deepEqualJson(team, snapshot.teams.find(value => value.id === team.id) ?? null)
            || reviewed.enabledTeams.includes(team.id) !== snapshot.enabledTeams.includes(team.id)
            || team.members.some(member => reviewed.enabledExperts.includes(member.expertSlug) !== snapshot.enabledExperts.includes(member.expertSlug)))) {
            setError("配置已更新，请读取最新内容后重试。");
            return;
        }
        if (!teamHasPinnedMembers(team)) {
            setError("团队成员需要重新选择并保存。");
            return;
        }
        if (!reviewed &&
            (!snapshot.enabledTeams.includes(team.id) ||
                teamIssue(team, experts, snapshot.enabledExperts))) {
            setConfirm({ team, example, snapshot });
            setError('');
            return;
        }
        const started = props.cache.teams.getSnapshot();
        operation.current = signal;
        setPending({ signal, teamId: team.id, example });
        try {
            const insert = props.prepareSelect?.();
            if (reviewed) {
                const next = await unwrap(props.remote.setTeamEnabled(team.id, true, reviewed.revision, signal));
                if (signal.aborted)
                    return;
                setConfirm(null);
                const accepted = await props.cache.teams.acceptMutation(next, started);
                if (signal.aborted) return;
                props.cache.catalog.adoptRevision(accepted.revision, accepted.enabledExperts);
            }
            if (signal.aborted)
                return;
            const current = props.cache.teams.getSnapshot();
            const selected = current?.teams.find(value => value.id === team.id);
            if (!current || !selected || !current.enabledTeams.includes(team.id)
                || teamIssue(selected, props.cache.catalog.getSnapshot().experts, current.enabledExperts)) {
                throw new Error(tx("团队已停用或成员失效，请修复后再发送。"));
            }
            const inserted = await insert?.(selected, example);
            if (signal.aborted) return;
            if (!inserted) throw new Error(tx("无法插入团队，请确认当前聊天草稿后重试。"));
            setError('');
            props.onSelected();
        }
        catch (cause) {
            if (!signal.aborted)
                setError(cause instanceof Error ? cause.message : "选择失败。");
        }
        finally {
            if (operation.current === signal) operation.current = null;
            if (!signal.aborted)
                setPending(null);
        }
    };
    const teams = snapshot?.teams.filter((t) => (query !== '' || snapshot.enabledTeams.includes(t.id)) &&
        `${t.name} ${t.description}`
            .toLowerCase()
            .includes(query.toLowerCase())) ?? [];
    return (<div className="agt-compact">
      <Input ref={searchRef} data-modal-autofocus aria-label={tx("搜索专家团")} placeholder={tx("搜索团队或工作目标")} value={query}
        onFocus={() => setFocused(null)} onChange={(e) => setQuery(e.target.value)}/>
      <div className="agt-compact-list">
        {teams.map((team) => (<div className="agt-compact-row" key={team.id}>
            <button ref={focused?.id === team.id && focused.action === 'choice' ? choiceFocus : undefined}
              onFocus={() => setFocused({ id: team.id, action: 'choice' })}
              type="button" aria-disabled={busy} className={busy ? 'product-control-pending' : undefined}
              aria-busy={busy && pending.teamId === team.id} onClick={() => void pick(team)}>
              <TeamAvatars team={team} experts={experts}/>
              <span>{team.name}</span>
              <small>
                {team.members.length}{tx("人")}{snapshot?.enabledTeams.includes(team.id)
                ? ''
                : tx(" \u00B7 启用并选择")}
              </small>
            </button>
            <button ref={focused?.id === team.id && focused.action === 'details' ? choiceFocus : undefined}
              onFocus={() => setFocused({ id: team.id, action: 'details' })}
              type="button" aria-label={tx("查看{0}详情", [team.name])} onClick={() => setDetailId(team.id)}>
              <IconEye size={16}/>
            </button>
          </div>))}
        {!teams.length && (<p className="aag-note" aria-hidden={snapshot === null && Boolean(error) || undefined}>
            {snapshot ? tx("搜索并启用一个专家团。") : error ? '' : tx("正在加载…")}
          </p>)}
      </div>
      <div className="aag-discovery-feedback" ref={feedbackRef}>
        <div className="aag-editor-feedback">
          {error && !detail && !confirm && <div className="aag-error" role="alert" tabIndex={0}>{error}</div>}
        </div>
        {error && !detail && !confirm && <Button size="sm" aria-disabled={directory.refreshing} aria-busy={directory.refreshing}
          className={directory.refreshing ? 'product-control-pending' : undefined} onClick={() => void directory.refresh()}>{tx("刷新")}</Button>}
      </div>
      {detail && (<TeamDetails team={detail} experts={experts} busy={busy} error={confirm ? undefined : error}
        refreshing={directory.refreshing} refreshLabel={tx("刷新")} onRefresh={() => void directory.refresh()}
        selecting={busy && pending.teamId === detail.id ? { example: pending.example } : undefined}
        close={() => { if (!operation.current || operation.current.aborted) setDetailId(null) }} onSelect={(example) => void pick(detail, example)}/>)}
      {confirm && (<TeamConfirm title={tx("启用专家团")} label={tx("启用团队及所需成员")} busy={busy} error={error}
        description={tx("启用“{0}”及所需成员：{1}", [confirm.team.name, confirm.team.members
            .map((m) => experts.find((e) => e.slug === m.expertSlug)?.name ?? tx("失效成员"))
            .join(locale === 'en' ? ', ' : '、')])}
        onCancel={() => { if (!operation.current || operation.current.aborted) setConfirm(null) }} onConfirm={() => {
                const value = confirm;
                void pick(value.team, value.example, value.snapshot);
            }} />)}
    </div>);
}
