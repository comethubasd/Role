import { findByProps, findByStoreName } from "@vendetta/metro";
import { clipboard, React, ReactNative as RN } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";

const { FormDivider, FormRow, FormSection, FormText } = Forms;
const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const GuildMemberCountStore = findByStoreName("GuildMemberCountStore");

const PICKER_KEY = "RoleMentionExporterRolePicker";
const INJECTED_KEY = "role-mention-exporter-button";

type DiscordRole = {
    id: string;
    name: string;
    color?: number;
    position?: number;
};

type DiscordMember = {
    userId?: string;
    user_id?: string;
    user?: { id?: string };
    roles?: string[];
};

function closeSheet(key?: string) {
    try {
        LazyActionSheet.hideActionSheet(key);
    } catch {
        try {
            LazyActionSheet.hideActionSheet();
        } catch {}
    }
}

function getGuildId(props: any): string | undefined {
    return props?.guild?.id
        ?? props?.guildId
        ?? props?.guild_id
        ?? props?.channel?.guild_id
        ?? props?.channel?.guildId;
}

function isGuildLongPressSheet(key: unknown, props: any): boolean {
    const sheetKey = String(key ?? "").toLowerCase();
    const guildId = getGuildId(props);

    if (!guildId) return false;

    // Discord has renamed this sheet before. These checks cover the usual
    // GuildContextMenu / GuildLongPressActionSheet-style names without
    // accidentally patching a member or channel menu.
    return sheetKey.includes("guild")
        && !sheetKey.includes("member")
        && !sheetKey.includes("user")
        && !sheetKey.includes("channel");
}

function normalizeMembers(raw: unknown): DiscordMember[] {
    if (Array.isArray(raw)) return raw as DiscordMember[];
    if (raw && typeof raw === "object") return Object.values(raw) as DiscordMember[];
    return [];
}

function getCachedMembers(guildId: string): DiscordMember[] {
    try {
        return normalizeMembers(GuildMemberStore.getMembers(guildId));
    } catch {
        return [];
    }
}

function getMemberId(member: DiscordMember): string | undefined {
    return member.userId ?? member.user_id ?? member.user?.id;
}

function getGuildRoles(guildId: string): DiscordRole[] {
    const guild = GuildStore.getGuild(guildId);
    if (!guild) return [];

    const rawRoles = guild.roles ?? guild.getRoles?.() ?? {};
    const roles = (Array.isArray(rawRoles) ? rawRoles : Object.values(rawRoles)) as DiscordRole[];

    return roles
        .filter(role => role?.id && role?.name)
        .sort((a, b) => {
            // Keep @everyone at the bottom, then sort highest role first.
            if (a.id === guildId) return 1;
            if (b.id === guildId) return -1;
            return (b.position ?? 0) - (a.position ?? 0);
        });
}

function getKnownGuildMemberCount(guildId: string): number | undefined {
    try {
        const count = GuildMemberCountStore?.getMemberCount?.(guildId)
            ?? GuildStore.getGuild(guildId)?.memberCount;
        return typeof count === "number" ? count : undefined;
    } catch {
        return undefined;
    }
}

function memberHasRole(member: DiscordMember, roleId: string, guildId: string): boolean {
    // Discord does not include @everyone in each member's roles array.
    if (roleId === guildId) return true;
    return Array.isArray(member.roles) && member.roles.includes(roleId);
}

function copyRoleMembers(guildId: string, role: DiscordRole) {
    const cachedMembers = getCachedMembers(guildId);
    const ids = Array.from(new Set(
        cachedMembers
            .filter(member => memberHasRole(member, role.id, guildId))
            .map(getMemberId)
            .filter((id): id is string => Boolean(id)),
    ));

    if (!ids.length) {
        showToast(
            `No cached members found with @${role.name}. Open the member list and scroll, then try again.`,
            getAssetIDByName("Small") ?? undefined,
        );
        return;
    }

    const mentionText = ids.map(id => `<@${id}>`).join(" ");
    clipboard.setString(mentionText);
    closeSheet(PICKER_KEY);

    const knownTotal = getKnownGuildMemberCount(guildId);
    const cacheWarning = knownTotal && cachedMembers.length < knownTotal
        ? ` Cached ${cachedMembers.length}/${knownTotal} server members, so more may exist.`
        : "";

    showToast(
        `Copied ${ids.length} member mention${ids.length === 1 ? "" : "s"} from @${role.name}.${cacheWarning}`,
        getAssetIDByName("CopyIcon") ?? undefined,
    );
}

function RolePickerSheet({ guildId }: { guildId: string }) {
    const roles = getGuildRoles(guildId);
    const cachedCount = getCachedMembers(guildId).length;
    const knownTotal = getKnownGuildMemberCount(guildId);

    return React.createElement(
        RN.View,
        { style: { maxHeight: 620, paddingBottom: 16 } },
        React.createElement(
            RN.ScrollView,
            { keyboardShouldPersistTaps: "handled" },
            React.createElement(
                FormSection,
                { title: "COPY MEMBERS BY ROLE" },
                React.createElement(FormText, null,
                    knownTotal && cachedCount < knownTotal
                        ? `Discord currently has ${cachedCount} of about ${knownTotal} members cached. Open and scroll the server member list first if you need a complete result.`
                        : `${cachedCount} server members are currently cached. Tap a role to copy its members as <@user_id> mentions.`,
                ),
                React.createElement(FormDivider, null),
                ...roles.flatMap((role, index) => {
                    const row = React.createElement(FormRow, {
                        key: role.id,
                        label: role.name,
                        subLabel: role.id === guildId ? "Every cached member" : undefined,
                        onPress: () => copyRoleMembers(guildId, role),
                    });
                    return index === roles.length - 1
                        ? [row]
                        : [row, React.createElement(FormDivider, { key: `${role.id}-divider` })];
                }),
            ),
        ),
    );
}

function openRolePicker(guildId: string) {
    closeSheet();
    LazyActionSheet.openLazy(
        Promise.resolve({ default: RolePickerSheet }),
        PICKER_KEY,
        { guildId },
    );
}

function findButtonArray(tree: any): any[] | undefined {
    return findInReactTree(tree, (node: any) =>
        Array.isArray(node)
        && node.some((child: any) => {
            const props = child?.props;
            return props
                && typeof props.onPress === "function"
                && (typeof props.message === "string"
                    || typeof props.label === "string"
                    || typeof props.text === "string");
        }),
    );
}

function injectGuildButton(componentPromise: Promise<any>, guildId: string) {
    componentPromise.then(module => {
        if (!module?.default) return;

        const unpatch = after("default", module, (_args, tree) => {
            React.useEffect(() => () => unpatch(), []);

            const buttons = findButtonArray(tree);
            if (!buttons || buttons.some((item: any) => item?.key === INJECTED_KEY)) return;

            const template = buttons.find((item: any) => typeof item?.props?.onPress === "function");
            if (!template) return;

            const title = "Copy members by role";
            const injected = React.cloneElement(template, {
                key: INJECTED_KEY,
                message: title,
                label: title,
                text: title,
                onPress: () => openRolePicker(guildId),
                // Let Discord render its normal row. An icon is intentionally omitted
                // because asset names vary across Discord versions.
                icon: getAssetIDByName("CopyIcon") ?? template.props.icon,
            });

            // Put it near the bottom, before destructive actions in most builds.
            buttons.splice(Math.max(buttons.length - 1, 0), 0, injected);
        });
    }).catch(() => {});
}

let unpatchGuildSheet: (() => void) | undefined;

function onLoad() {
    if (!LazyActionSheet?.openLazy || !GuildStore || !GuildMemberStore) {
        showToast("Role Mention Exporter could not find Discord's required modules.");
        return;
    }

    unpatchGuildSheet = before(
        "openLazy",
        LazyActionSheet,
        ([componentPromise, key, props]) => {
            if (!isGuildLongPressSheet(key, props)) return;
            const guildId = getGuildId(props);
            if (!guildId || !componentPromise?.then) return;
            injectGuildButton(componentPromise, guildId);
        },
    );
}

function onUnload() {
    unpatchGuildSheet?.();
    unpatchGuildSheet = undefined;
    closeSheet(PICKER_KEY);
}

export default { onLoad, onUnload };
