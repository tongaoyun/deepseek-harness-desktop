import type { ExpertClientState } from './client-state.ts'
import { useTeamLocale, localizedExperts } from './team-locale.ts';
import React from 'react';
import type { ExpertTeam, TeamSnapshot } from '../team-contract.ts';
import type { ExpertSummary } from '../expert-contract.ts';
import { TeamDetails, unwrap, type TeamRemote } from './team-ui.tsx';
import { TeamAvatars, TeamConfirm, teamIssue, IconEye } from './team-shared.tsx';
import { Input } from './plugin-ui.ts';
export function TeamMenu(props: {
    cache: ExpertClientState;
    remote: TeamRemote;
    prepareSelect?(): (team: ExpertTeam, example?: string) => boolean | Promise<boolean>;
    onSelected(): void;
}) {
    const { locale, tx } = useTeamLocale();

    const [snapshot, setSnapshot] = React.useState<TeamSnapshot | null>(() => props.cache.teams.getSnapshot());
    const [rawExperts, setExperts] = React.useState<ExpertSummary[]>(() => {
        const catalog = props.cache.catalog.getSnapshot();
        return catalog.revision < 0 ? [] : [...catalog.experts];
    });
    const experts = localizedExperts(rawExperts, locale);
    const [query, setQuery] = React.useState('');
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [detail, setDetail] = React.useState<ExpertTeam | null>(null);
    const [confirm, setConfirm] = React.useState<{
        team: ExpertTeam;
        example?: string;
    } | null>(null);
    const lifetime = React.useRef<AbortController | undefined>(undefined);
    React.useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        setBusy(false);
        setError('');
        setDetail(null);
        setConfirm(null);
        const updateTeams = () => {
            const next = props.cache.teams.getSnapshot();
            setSnapshot(next);
            if (!next) { setDetail(null); setConfirm(null); }
        };
        const updateExperts = () => setExperts([...props.cache.catalog.getSnapshot().experts]);
        const unsubscribeTeams = props.cache.teams.subscribe(updateTeams);
        const unsubscribeExperts = props.cache.catalog.subscribe(updateExperts);
        updateTeams();
        updateExperts();
        void load();
        return () => {
            controller.abort();
            unsubscribeTeams();
            unsubscribeExperts();
        };
    }, [props.remote, props.cache]);
    const load = async () => {
        const signal = lifetime.current?.signal;
        if (!signal || signal.aborted) return;
        try {
            await props.cache.teams.refresh();
            if (signal.aborted) return;
            if (props.cache.catalog.getSnapshot().revision < 0) await props.cache.catalog.refresh();
            if (!signal.aborted) setError('');
        }
        catch (cause) {
            if (!signal.aborted)
                setError(cause instanceof Error ? tx(cause.message) : tx("专家团加载失败"));
        }
    };
    const pick = async (team: ExpertTeam, example?: string, confirmed = false) => {
        const signal = lifetime.current?.signal;
        if (busy || !snapshot || !signal || signal.aborted)
            return;
        if (!confirmed &&
            (!snapshot.enabledTeams.includes(team.id) ||
                teamIssue(team, experts, snapshot.enabledExperts))) {
            setConfirm({ team, example });
            return;
        }
        const insert = props.prepareSelect?.();
        setBusy(true);
        try {
            if (confirmed) {
                const next = await unwrap(props.remote.setTeamEnabled(team.id, true, snapshot.revision));
                if (signal.aborted)
                    return;
                const accepted = props.cache.teams.accept(next);
                props.cache.catalog.adoptRevision(accepted.revision, accepted.enabledExperts);
            }
            if (signal.aborted)
                return;
            const inserted = await insert?.(team, example);
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
      <Input autoFocus aria-label={tx("搜索专家团")} placeholder={tx("搜索团队或工作目标")} value={query} onChange={(e) => setQuery(e.target.value)}/>
      {error && (<div role="alert">
          {error}
          <button type="button" className="agt-plain-btn" onClick={() => void load()}>{tx("刷新")}</button>
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
            <button type="button" aria-label={tx("查看{0}详情", [team.name])} onClick={() => setDetail(team)}>
              <IconEye size={16}/>
            </button>
          </div>))}
        {!teams.length && (<p className="aag-note">
            {snapshot ? tx("搜索并启用一个专家团。") : tx("正在加载…")}
          </p>)}
      </div>
      {detail && (<TeamDetails team={detail} experts={experts} engine={snapshot?.engine} close={() => setDetail(null)} onSelect={(example) => void pick(detail, example)}/>)}
      {confirm && (<TeamConfirm title={tx("启用专家团")} label={tx("启用团队及所需成员")} onCancel={() => setConfirm(null)} onConfirm={() => {
                const value = confirm;
                setConfirm(null);
                void pick(value.team, value.example, true);
            }}>
          <p>{tx("启用“")}{confirm.team.name}{tx("”及所需成员：")}{confirm.team.members
                .map((m) => experts.find((e) => e.slug === m.expertSlug)?.name ?? tx("失效成员"))
                .join(locale === 'en' ? ', ' : '、')}
            。
          </p>
        </TeamConfirm>)}
    </div>);
}
