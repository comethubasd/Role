import { findByProps, findByStoreName } from "@vendetta/metro";
import { clipboard } from "@vendetta/metro/common";
import { before } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const SimpleActionSheet = findByProps("showSimpleActionSheet");
const FullActionSheet = findByProps(
    "showActionSheet",
    "ACTION_SHEET_HEIGHT_HALF",
    "ACTION_SHEET_HEIGHT_EXPANDED",
);
const ActionSheetManager = findByProps("openLazy", "hideActionSheet", "hideAllActionSheets");

const GuildStore = findByStoreName("GuildStore");
const GuildRoleStore = findByStoreName("GuildRoleStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const GuildMemberCountStore = findByStoreName("GuildMemberCountStore");
const SelectedGuildStore = findByStoreName("SelectedGuildStore");

const RestAPI = findByProps("get", "post", "put", "del")
    ?? findByProps("get", "post", "patch", "del");
const Endpoints = findByProps("GUILD_ROLE_MEMBER_IDS", "GUILD_ROLE_MEMBER_COUNTS");

const BUTTON_LABEL = "Get every member with role";
const BUTTON_MARKER = "__roleMentionExporterButton";
const PICKER_KEY = "RoleMentionExporterRolePickerV3";
const SERVER_MENU_LABELS = ["mark as read", "notifications", "more options"];
const roleCountCache = new Map<string, Record<string, number>>();
const unpatches: Array<() => void> = [];

let copyIcon: number | undefined;
let peopleIcon: number | undefined;

type DiscordRole = {
    id: string;
    name: string;
    position?: number;
};

type DiscordMember = {
    userId?: string;
    user_id?: string;
    user?: { id?: string };
    roles?: string[];
    roleIds?: string[];
    role_ids?: string[];
};

function getAsset(name: string): number | undefined {
    try {
        return getAssetIDByName(name) ?? undefined;
    } catch {
        return undefined;
    }
}

function normalize(value: unknown): string {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9@]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function textFrom(value: any, depth = 0, seen = new Set<any>()): string {
    if (depth > 7 || value == null) return "";
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(item => textFrom(item, depth + 1, seen)).filter(Boolean).join(" ");
    }

    const keys = [
        "defaultMessage",
        "message",
        "label",
        "title",
        "text",
        "content",
        "children",
        "name",
    ];

    return keys
        .filter(key => key in value)
        .map(key => textFrom(value[key], depth + 1, seen))
        .filter(Boolean)
        .join(" ");
}

function valuesOf(value: any): any[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Map) return Array.from(value.values());
    if (typeof value === "object") return Object.values(value);
    return [];
}

function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && /^\d{15,22}$/.test(value);
}

function getAllGuilds(): any[] {
    try {
        return valuesOf(GuildStore?.getGuilds?.());
    } catch {
        return [];
    }
}

function isGuildId(value: unknown): value is string {
    if (!isSnowflake(value)) return false;
    try {
        return Boolean(GuildStore?.getGuild?.(value));
    } catch {
        return false;
    }
}

function findGuildIdDeep(value: any, depth = 0, seen = new Set<any>()): string | undefined {
    if (depth > 5 || value == null) return undefined;
    if (isGuildId(value)) return value;
    if (typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);

    const priority = ["guildId", "guild_id", "guildID", "guild", "id"];
    for (const key of priority) {
        if (!(key in value)) continue;
        const found = findGuildIdDeep(value[key], depth + 1, seen);
        if (found) return found;
    }

    for (const nested of valuesOf(value)) {
        const found = findGuildIdDeep(nested, depth + 1, seen);
        if (found) return found;
    }

    return undefined;
}

function resolveGuildId(config: any): string | undefined {
    const direct = findGuildIdDeep(config);
    if (direct) return direct;

    const headerText = normalize(textFrom(config?.header?.title ?? config?.title ?? config?.header));
    if (headerText) {
        const matches = getAllGuilds().filter(guild => {
            const name = normalize(guild?.name);
            return name && (headerText === name || headerText.startsWith(`${name} `));
        });
        if (matches.length === 1 && isGuildId(matches[0]?.id)) return matches[0].id;
    }

    try {
        const selected = SelectedGuildStore?.getGuildId?.()
            ?? SelectedGuildStore?.getLastSelectedGuildId?.();
        if (isGuildId(selected)) return selected;
    } catch {}

    return undefined;
}

function optionLabel(option: any): string {
    return normalize(textFrom(option?.label ?? option?.title ?? option?.text ?? option));
}

function isServerMenu(config: any): boolean {
    if (!config || !Array.isArray(config.options)) return false;
    if (config.key === PICKER_KEY) return false;

    const labels = config.options.map(optionLabel);
    const matchingLabels = SERVER_MENU_LABELS.filter(expected =>
        labels.some(label => label.includes(expected)),
    ).length;

    if (matchingLabels >= 2) return true;

    const key = normalize(config.key);
    return (key.includes("guild") || key.includes("server"))
        && labels.some(label => label.includes("more options"));
}

function makeMenuOption(guildId: string): any {
    const option: any = {
        label: BUTTON_LABEL,
        onPress: () => {
            closeAllSheets();
            setTimeout(() => void openRolePicker(guildId), 120);
        },
        [BUTTON_MARKER]: true,
    };

    if (peopleIcon) option.icon = peopleIcon;
    return option;
}

function injectConfig(config: any): any {
    if (!isServerMenu(config)) return config;
    if (config.options.some((option: any) => option?.[BUTTON_MARKER] || optionLabel(option) === normalize(BUTTON_LABEL))) {
        return config;
    }

    const guildId = resolveGuildId(config);
    if (!guildId) return config;

    const nextOptions = [...config.options];
    const moreOptionsIndex = nextOptions.findIndex((option: any) =>
        optionLabel(option).includes("more options"),
    );
    const insertIndex = moreOptionsIndex >= 0 ? moreOptionsIndex : nextOptions.length;
    nextOptions.splice(insertIndex, 0, makeMenuOption(guildId));

    if (!Object.isFrozen(config)) {
        try {
            config.options = nextOptions;
            return config;
        } catch {}
    }

    return { ...config, options: nextOptions };
}

function patchSheetArguments(args: any[]): any[] | void {
    if (!Array.isArray(args) || !args.length) return;

    let changed = false;
    const nextArgs = args.map(arg => {
        if (!arg || typeof arg !== "object" || !Array.isArray(arg.options)) return arg;
        const next = injectConfig(arg);
        if (next !== arg || next.options !== arg.options) changed = true;
        return next;
    });

    if (changed) return nextArgs;
}

function closeAllSheets() {
    try {
        ActionSheetManager?.hideAllActionSheets?.();
        return;
    } catch {}

    try {
        ActionSheetManager?.hideActionSheet?.();
    } catch {}
}

function getGuildRoles(guildId: string): DiscordRole[] {
    let raw: any;

    try {
        raw = GuildStore?.getGuild?.(guildId)?.roles;
    } catch {}

    if (!raw) {
        for (const method of ["getRoles", "getRolesSnapshot"]) {
            try {
                raw = GuildRoleStore?.[method]?.(guildId);
                if (raw) break;
            } catch {}
        }
    }

    return valuesOf(raw)
        .filter((role: any): role is DiscordRole => Boolean(role?.id && role?.name))
        .sort((a: DiscordRole, b: DiscordRole) => {
            if (a.id === guildId) return 1;
            if (b.id === guildId) return -1;
            return (b.position ?? 0) - (a.position ?? 0);
        });
}

function getCachedMembers(guildId: string): DiscordMember[] {
    for (const method of ["getMembers", "getMutableGuildMembers", "getGuildMembers"]) {
        try {
            const members = valuesOf(GuildMemberStore?.[method]?.(guildId));
            if (members.length) return members as DiscordMember[];
        } catch {}
    }
    return [];
}

function getMemberId(member: DiscordMember): string | undefined {
    return member?.userId ?? member?.user_id ?? member?.user?.id;
}

function getMemberRoles(member: DiscordMember): string[] {
    const roles = member?.roles ?? member?.roleIds ?? member?.role_ids;
    return Array.isArray(roles) ? roles : [];
}

function getCachedRoleMemberIds(guildId: string, roleId: string): string[] {
    const ids = getCachedMembers(guildId)
        .filter(member => roleId === guildId || getMemberRoles(member).includes(roleId))
        .map(getMemberId)
        .filter((id): id is string => Boolean(id));

    return Array.from(new Set(ids));
}

function getGuildMemberCount(guildId: string): number | undefined {
    try {
        const count = GuildMemberCountStore?.getMemberCount?.(guildId)
            ?? GuildMemberCountStore?.getGuildMemberCount?.(guildId)
            ?? GuildStore?.getGuild?.(guildId)?.memberCount;
        return typeof count === "number" ? count : undefined;
    } catch {
        return undefined;
    }
}

function responseBody(response: any): any {
    return response?.body ?? response?.data ?? response;
}

function roleCountsUrl(guildId: string): string {
    try {
        const endpoint = Endpoints?.GUILD_ROLE_MEMBER_COUNTS?.(guildId);
        if (typeof endpoint === "string") return endpoint;
    } catch {}
    return `/guilds/${guildId}/roles/member-counts`;
}

function roleMemberIdsUrl(guildId: string, roleId: string): string {
    try {
        const endpoint = Endpoints?.GUILD_ROLE_MEMBER_IDS?.(guildId, roleId);
        if (typeof endpoint === "string") return endpoint;
    } catch {}
    return `/guilds/${guildId}/roles/${roleId}/member-ids`;
}

async function fetchRoleCounts(guildId: string): Promise<Record<string, number> | undefined> {
    if (!RestAPI?.get) return undefined;

    try {
        const response = await RestAPI.get({ url: roleCountsUrl(guildId) });
        const body = responseBody(response);
        if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;

        const counts: Record<string, number> = {};
        for (const [roleId, count] of Object.entries(body)) {
            if (typeof count === "number") counts[roleId] = count;
        }
        roleCountCache.set(guildId, counts);
        return counts;
    } catch {
        return undefined;
    }
}

async function fetchRemoteRoleMemberIds(guildId: string, roleId: string): Promise<string[]> {
    if (!RestAPI?.get || roleId === guildId) return [];

    try {
        const response = await RestAPI.get({ url: roleMemberIdsUrl(guildId, roleId) });
        const body = responseBody(response);
        if (!Array.isArray(body)) return [];
        return body.filter(isSnowflake);
    } catch {
        return [];
    }
}

function expectedRoleCount(
    guildId: string,
    roleId: string,
    counts?: Record<string, number>,
): number | undefined {
    if (roleId === guildId) return getGuildMemberCount(guildId);
    const count = counts?.[roleId] ?? roleCountCache.get(guildId)?.[roleId];
    return typeof count === "number" ? count : undefined;
}

async function copyMembersForRole(guildId: string, role: DiscordRole) {
    showToast(`Getting members with @${role.name}...`, peopleIcon);

    const cachedIds = getCachedRoleMemberIds(guildId, role.id);
    const [remoteIds, counts] = await Promise.all([
        fetchRemoteRoleMemberIds(guildId, role.id),
        roleCountCache.has(guildId) ? Promise.resolve(roleCountCache.get(guildId)) : fetchRoleCounts(guildId),
    ]);

    const ids = Array.from(new Set([...remoteIds, ...cachedIds]));
    const expected = expectedRoleCount(guildId, role.id, counts);

    if (!ids.length) {
        showToast(`No members found with @${role.name}.`, getAsset("Small"));
        return;
    }

    clipboard.setString(ids.map(id => `<@${id}>`).join(" "));

    if (expected !== undefined && ids.length < expected) {
        showToast(
            `Copied ${ids.length}/${expected}. Scroll the server member list, then run it again for more.`,
            copyIcon,
        );
        return;
    }

    showToast(
        `Copied ${ids.length} member mention${ids.length === 1 ? "" : "s"} from @${role.name}.`,
        copyIcon,
    );
}

async function openRolePicker(guildId: string) {
    const guild = GuildStore?.getGuild?.(guildId);
    const roles = getGuildRoles(guildId);

    if (!roles.length) {
        showToast("No roles were found for this server.", getAsset("Small"));
        return;
    }

    const counts = await fetchRoleCounts(guildId);
    const options = roles.map(role => {
        const cachedCount = getCachedRoleMemberIds(guildId, role.id).length;
        const expected = expectedRoleCount(guildId, role.id, counts);
        const countText = expected !== undefined ? String(expected) : `${cachedCount} loaded`;
        const option: any = {
            label: `${role.name} (${countText})`,
            onPress: () => {
                closeAllSheets();
                setTimeout(() => void copyMembersForRole(guildId, role), 100);
            },
        };
        if (peopleIcon) option.icon = peopleIcon;
        return option;
    });

    try {
        SimpleActionSheet.showSimpleActionSheet({
            key: PICKER_KEY,
            header: {
                title: `Choose a role — ${guild?.name ?? "Server"}`,
            },
            options,
        });
    } catch (error) {
        console.warn("[RoleMentionExporter] Failed to open role picker", error);
        showToast("Could not open the role picker.", getAsset("Small"));
    }
}

function onLoad() {
    copyIcon = getAsset("CopyIcon");
    peopleIcon = getAsset("MemberListIcon") ?? getAsset("FriendsIcon") ?? copyIcon;

    if (!SimpleActionSheet?.showSimpleActionSheet) {
        showToast("Role exporter could not find Discord's simple action sheet.", getAsset("Small"));
        return;
    }

    unpatches.push(before(
        "showSimpleActionSheet",
        SimpleActionSheet,
        (args: any[]) => patchSheetArguments(args),
    ));

    if (FullActionSheet?.showActionSheet) {
        unpatches.push(before(
            "showActionSheet",
            FullActionSheet,
            (args: any[]) => patchSheetArguments(args),
        ));
    }

    showToast("Role Mention Exporter v3 loaded", copyIcon);
}

function onUnload() {
    while (unpatches.length) {
        try {
            unpatches.pop()?.();
        } catch {}
    }
    roleCountCache.clear();
    closeAllSheets();
}

export default { onLoad, onUnload };
