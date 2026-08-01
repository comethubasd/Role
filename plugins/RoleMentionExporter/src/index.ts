import { registerCommand } from "@vendetta/commands";
import { findByStoreName } from "@vendetta/metro";
import { clipboard } from "@vendetta/metro/common";
import { showToast } from "@vendetta/ui/toasts";

const GuildMemberStore = findByStoreName("GuildMemberStore");
const GuildMemberCountStore = findByStoreName("GuildMemberCountStore");
const GuildStore = findByStoreName("GuildStore");
const GuildRoleStore = findByStoreName("GuildRoleStore");

const ROLE_OPTION_TYPE = 8;
let unregisterCommand;

function normalizeMembers(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object") return Object.values(raw);
    return [];
}

function getCachedMembers(guildId) {
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

function getMemberId(member) {
    return member?.userId
        ?? member?.user_id
        ?? member?.user?.id
        ?? member?.id;
}

function getMemberRoleIds(member) {
    const roles = member?.roles
        ?? member?.roleIds
        ?? member?.role_ids;

    return Array.isArray(roles) ? roles : [];
}

function getGuildId(commandContext) {
    const guild = commandContext?.guild;
    const channel = commandContext?.channel;

    if (typeof guild === "string") return guild;

    return guild?.id
        ?? guild?.guildId
        ?? guild?.guild_id
        ?? channel?.guild_id
        ?? channel?.guildId;
}

function getSelectedRoleId(args) {
    const roleArgument = args?.find?.(argument => argument?.name === "role")
        ?? args?.[0];

    const value = roleArgument?.value;

    if (typeof value === "string") return value;
    return value?.id;
}

function getRoleName(guildId, roleId) {
    if (roleId === guildId) return "@everyone";

    try {
        const roles = GuildRoleStore?.getRoles?.(guildId) ?? {};
        const role = Array.isArray(roles)
            ? roles.find(item => item?.id === roleId)
            : roles?.[roleId];

        return role?.name ? `@${role.name}` : "the selected role";
    } catch {
        return "the selected role";
    }
}

function getKnownMemberCount(guildId) {
    try {
        const count = GuildMemberCountStore?.getMemberCount?.(guildId)
            ?? GuildMemberCountStore?.getGuildMemberCount?.(guildId)
            ?? GuildStore?.getGuild?.(guildId)?.memberCount;

        return typeof count === "number" ? count : undefined;
    } catch {
        return undefined;
    }
}

function memberHasRole(member, roleId, guildId) {
    // Discord uses the guild ID as the @everyone role ID.
    if (roleId === guildId) return true;
    return getMemberRoleIds(member).includes(roleId);
}

function copyMembersByRole(args, commandContext) {
    const guildId = getGuildId(commandContext);

    if (!guildId) {
        showToast("Use /rolemembers inside a server.");
        return;
    }

    const roleId = getSelectedRoleId(args);

    if (!roleId) {
        showToast("Choose a role first.");
        return;
    }

    const cachedMembers = getCachedMembers(guildId);
    const memberIds = Array.from(new Set(
        cachedMembers
            .filter(member => memberHasRole(member, roleId, guildId))
            .map(getMemberId)
            .filter(Boolean),
    ));

    const roleName = getRoleName(guildId, roleId);

    if (memberIds.length === 0) {
        showToast(
            `No loaded members were found with ${roleName}. Open the server member list, scroll through it, and try again.`,
        );
        return;
    }

    clipboard.setString(
        memberIds.map(memberId => `<@${memberId}>`).join(" "),
    );

    const knownMemberCount = getKnownMemberCount(guildId);
    const cacheIsIncomplete = typeof knownMemberCount === "number"
        && cachedMembers.length < knownMemberCount;

    showToast(
        cacheIsIncomplete
            ? `Copied ${memberIds.length} loaded member mention${memberIds.length === 1 ? "" : "s"} from ${roleName}. Discord only has ${cachedMembers.length}/${knownMemberCount} server members loaded, so the result may be incomplete.`
            : `Copied ${memberIds.length} member mention${memberIds.length === 1 ? "" : "s"} from ${roleName}.`,
    );
}

function onLoad() {
    unregisterCommand?.();

    unregisterCommand = registerCommand({
        name: "rolemembers",
        displayName: "rolemembers",
        description: "Copy loaded members with a selected server role",
        displayDescription: "Copy loaded members with a selected server role",
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
