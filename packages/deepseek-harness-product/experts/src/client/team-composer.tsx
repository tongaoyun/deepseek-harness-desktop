import type { ExpertClientState } from './client-state.ts'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import React from 'react';
import type { ExpertTeam, TeamSnapshot } from '../team-contract.ts';
import { TeamDetails, unwrap, type TeamRemote } from './team-ui.tsx';
import { TeamAvatars, TeamConfirm, teamIssue, IconEye } from './team-shared.tsx';
import { Input } from './plugin-ui.ts';
import { useTeamDirectoryView } from './team-directory.ts';
export function TeamMenu(props: {
    cache: ExpertClientState;
    remote: TeamRemote;
    prepareSelect?(): (team: ExpertTeam, example?: string) => boolean | Promise<boolean>;
    onSelected(): void;
}) {
    const { locale, tx, error, setError, directory, snapshot, experts } = useTeamDirectoryView({ cache: props.cache, remote: props.remote, fallback: "专家团加载失败" });
    const [query, setQuery] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [detailId, setDetailId] = React.useState<string | null>(null);
    const detail = snapshot?.teams.find(team => team.id === detailId) ?? null;
    const [confirm, setConfirm] = React.useState<{
        team: ExpertTeam;
        example?: string;
        snapshot: TeamSnapshot;
    } | null>(null);
    React.useEffect(() => {
        setBusy(false);
        setError('');
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
        if (busy || !snapshot || !signal || signal.aborted)
            return;
        if (reviewed && (reviewed.revision !== snapshot.revision
            || !deepEqualJson(team, snapshot.teams.find(value => value.id === team.id) ?? null)
            || reviewed.enabledTeams.includes(team.id) !== snapshot.enabledTeams.includes(team.id)
            || team.members.some(member => reviewed.enabledExperts.includes(member.expertSlug) !== snapshot.enabledExperts.includes(member.expertSlug)))) {
            setError(tx("配置已更新，请读取最新内容后重试。"));
            return;
        }
        if (!reviewed &&
            (!snapshot.enabledTeams.includes(team.id) ||
                teamIssue(team, experts, snapshot.enabledExperts))) {
            setConfirm({ team, example, snapshot });
            return;
        }
        const insert = props.prepareSelect?.();
        const started = props.cache.teams.getSnapshot();
        setBusy(true);
        try {
            if (reviewed) {
                const next = await unwrap(props.remote.setTeamEnabled(team.id, true, reviewed.revision, signal));
                if (signal.aborted)
                    return;
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
            props.onSelected();
        }
        catch (cause) {
            if (!signal.aborted)
                setError(cause instanceof Error ? tx(cause.message) : tx("选择失败。"));
        }
        finally {
            if (!signal.aborted)
                setBusy(false);
        }
    };
    const teams = snapshot?.teams.filter((t) => (query !== '' || snapshot.enabledTeams.includes(t.id)) &&
        `${t.name} ${t.description}`
            .toLowerCase()
            .includes(query.toLowerCase())) ?? [];
    return (<div className="agt-compact">
      <Input data-modal-autofocus aria-label={tx("搜索专家团")} placeholder={tx("搜索团队或工作目标")} value={query} onChange={(e) => setQuery(e.target.value)}/>
      {error && (<div role="alert">
          {error}
          <button type="button" className="agt-plain-btn" onClick={() => void directory.refresh()}>{tx("刷新")}</button>
        </div>)}
      <div className="agt-compact-list">
        {teams.map((team) => (<div className="agt-compact-row" key={team.id}>
            <button type="button" disabled={busy} onClick={() => void pick(team)}>
              <TeamAvatars team={team} experts={experts}/>
              <span>{team.name}</span>
              <small>
                {team.members.length}{tx("人")}{snapshot?.enabledTeams.includes(team.id)
                ? ''
                : tx(" \u00B7 启用并选择")}
              </small>
            </button>
            <button type="button" aria-label={tx("查看{0}详情", [team.name])} onClick={() => setDetailId(team.id)}>
              <IconEye size={16}/>
            </button>
          </div>))}
        {!teams.length && (<p className="aag-note">
            {snapshot ? tx("搜索并启用一个专家团。") : tx("正在加载…")}
          </p>)}
      </div>
      {detail && (<TeamDetails team={detail} experts={experts} engine={snapshot?.engine} close={() => setDetailId(null)} onSelect={(example) => void pick(detail, example)}/>)}
      {confirm && (<TeamConfirm title={tx("启用专家团")} label={tx("启用团队及所需成员")} onCancel={() => setConfirm(null)} onConfirm={() => {
                const value = confirm;
                setConfirm(null);
                void pick(value.team, value.example, value.snapshot);
            }}>
          <p>{tx("启用“")}{confirm.team.name}{tx("”及所需成员：")}{confirm.team.members
                .map((m) => experts.find((e) => e.slug === m.expertSlug)?.name ?? tx("失效成员"))
                .join(locale === 'en' ? ', ' : '、')}
            。
          </p>
        </TeamConfirm>)}
    </div>);
}
