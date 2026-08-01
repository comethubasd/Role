import { registerCommand } from "@vendetta/commands";
import { findByProps, findByStoreName } from "@vendetta/metro";
import { clipboard } from "@vendetta/metro/common";
import { showToast } from "@vendetta/ui/toasts";

const RestAPI =
    findByProps("get", "post", "patch")
    ?? findByProps("get", "post", "put", "del");

const GuildMemberStore = findByStoreName("GuildMemberStore");
const GuildRoleStore = findByStoreName("GuildRoleStore");

const ROLE_OPTION_TYPE = 8;
let unregisterCommand: (() => void) | undefined;

type CommandArgument = {
    name?: string;
    value?: string | { id?: string };
};

type CommandContext = {
    channel?: {
        guild_id?: string;
        guildId?: string;
    };
    guild?: {
        id?: string;
        guildId?: string;
        guild_id?: string;
    } | string;
};

type GuildMember = {
    id?: string;
    userId?: string;
    user_id?: string;
    user?: {
        id?: string;
    };
    roles?: string[];
    roleIds?: string[];
    role_ids?: string[];
};

function normalizeMembers(raw: unknown): GuildMember[] {
    if (Array.isArray(raw)) return raw as GuildMember[];
    if (raw && typeof raw === "object") {
        return Object.values(raw) as GuildMember[];
    }

    return [];
}

function getCachedMembers(guildId: string): GuildMember[] {
    const getterNames = [
        "getMembers",
        "getMutableGuildMembers",
        "getGuildMembers",
    ];

    for (const getterName of getterNames) {
        try {
            const members = normalizeMembers(
                GuildMemberStore?.[getterName]?.(guildId),
            );

            if (members.length > 0) return members;
        } catch {}
    }

    return [];
}

function getMemberId(member: GuildMember): string | undefined {
    return member?.userId
        ?? member?.user_id
        ?? member?.user?.id
        ?? member?.id;
}

function getMemberRoleIds(member: GuildMember): string[] {
    const roles = member?.roles
        ?? member?.roleIds
        ?? member?.role_ids;

    return Array.isArray(roles) ? roles : [];
}

function memberHasRole(
    member: GuildMember,
    roleId: string,
    guildId: string,
): boolean {
    // Discord uses the guild ID as the @everyone role ID.
    if (roleId === guildId) return true;
    return getMemberRoleIds(member).includes(roleId);
}

function getGuildId(context: CommandContext): string | undefined {
    if (typeof context?.guild === "string") return context.guild;

    return context?.guild?.id
        ?? context?.guild?.guildId
        ?? context?.guild?.guild_id
        ?? context?.channel?.guild_id
        ?? context?.channel?.guildId;
}

function getSelectedRoleId(
    args: CommandArgument[],
): string | undefined {
    const roleArgument =
        args?.find(argument => argument?.name === "role")
        ?? args?.[0];

    const value = roleArgument?.value;

    if (typeof value === "string") return value;
    return value?.id;
}

function getRoleName(guildId: string, roleId: string): string {
    if (roleId === guildId) return "@everyone";

    try {
        const rawRoles = GuildRoleStore?.getRoles?.(guildId) ?? {};
        const role = Array.isArray(rawRoles)
            ? rawRoles.find(item => item?.id === roleId)
            : rawRoles?.[roleId];

        return role?.name ? `@${role.name}` : "the selected role";
    } catch {
        return "the selected role";
    }
}

function parseResponseBody(response: any): any {
    if (response?.body !== undefined) return response.body;
    return response;
}

function parseMemberIds(response: any): string[] {
    const body = parseResponseBody(response);

    const possibleLists = [
        body,
        body?.member_ids,
        body?.memberIds,
        body?.members,
    ];

    for (const list of possibleLists) {
        if (!Array.isArray(list)) continue;

        return list
            .map(item => {
                if (typeof item === "string") return item;
                return item?.id
                    ?? item?.user_id
                    ?? item?.userId
                    ?? item?.user?.id;
            })
            .filter((id): id is string => typeof id === "string");
    }

    return [];
}

async function fetchRoleMemberIds(
    guildId: string,
    roleId: string,
): Promise<string[]> {
    if (!RestAPI?.get) {
        throw new Error("Discord REST module was not found.");
    }

    // This endpoint does not return @everyone members.
    if (roleId === guildId) return [];

    const response = await RestAPI.get({
        url: `/guilds/${guildId}/roles/${roleId}/member-ids`,
    });

    return parseMemberIds(response);
}

async function fetchRoleMemberCount(
    guildId: string,
    roleId: string,
): Promise<number | undefined> {
    if (!RestAPI?.get || roleId === guildId) return undefined;

    try {
        const response = await RestAPI.get({
            url: `/guilds/${guildId}/roles/member-counts`,
        });

        const body = parseResponseBody(response);
        const count = body?.[roleId];

        return typeof count === "number" ? count : undefined;
    } catch {
        return undefined;
    }
}

function getCachedRoleMemberIds(
    guildId: string,
    roleId: string,
): string[] {
    return getCachedMembers(guildId)
        .filter(member => memberHasRole(member, roleId, guildId))
        .map(getMemberId)
        .filter((id): id is string => typeof id === "string");
}

async function copyMembersByRole(
    args: CommandArgument[],
    context: CommandContext,
) {
    const guildId = getGuildId(context);

    if (!guildId) {
        showToast("Use /rolemembers inside a server.");
        return;
    }

    const roleId = getSelectedRoleId(args);

    if (!roleId) {
        showToast("Choose a role first.");
        return;
    }

    const roleName = getRoleName(guildId, roleId);
    const cachedIds = getCachedRoleMemberIds(guildId, roleId);

    let fetchedIds: string[] = [];
    let fetchFailed = false;

    try {
        fetchedIds = await fetchRoleMemberIds(guildId, roleId);
    } catch (error) {
        fetchFailed = true;
        console.error("[RoleMentionExporter] Role fetch failed:", error);
    }

    const ids = Array.from(new Set([
        ...fetchedIds,
        ...cachedIds,
    ]));

    if (ids.length === 0) {
        showToast(
            fetchFailed
                ? `Could not fetch ${roleName}, and no matching cached members were found.`
                : `No members were found with ${roleName}.`,
        );
        return;
    }

    clipboard.setString(
        ids.map(memberId => `<@${memberId}>`).join(" "),
    );

    const expectedCount = await fetchRoleMemberCount(guildId, roleId);

    if (
        typeof expectedCount === "number"
        && ids.length < expectedCount
    ) {
        showToast(
            `Copied ${ids.length}/${expectedCount} members from ${roleName}. Discord returned fewer role-member IDs than the role count, so the result may be incomplete.`,
        );
        return;
    }

    if (fetchFailed) {
        showToast(
            `The direct role fetch failed, but ${ids.length} cached member mention${ids.length === 1 ? "" : "s"} from ${roleName} were copied.`,
        );
        return;
    }

    showToast(
        `Copied ${ids.length} member mention${ids.length === 1 ? "" : "s"} from ${roleName}.`,
    );
}

function onLoad() {
    unregisterCommand?.();

    unregisterCommand = registerCommand({
        name: "rolemembers",
        displayName: "rolemembers",
        description: "Fetch and copy members with a selected server role",
        displayDescription: "Fetch and copy members with a selected server role",
        shouldHide: () => true,
        options: [
            {
                name: "role",
                displayName: "role",
                description: "The server role whose members should be copied",
                displayDescription: "The server role whose members should be copied",
                type: ROLE_OPTION_TYPE,
                required: true,
            },
        ],
        execute: copyMembersByRole,
    });

    showToast("Role Members loaded. Type /rolemembers");
}

function onUnload() {
    unregisterCommand?.();
    unregisterCommand = undefined;
}

export default {
    onLoad,
    onUnload,
};
