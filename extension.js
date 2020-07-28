"use strict";
import { ChannelServiceType } from "@codestream/protocols/api";
import { Disposable, Uri } from "vscode";
import { getApi, LiveShare, SessionChangeEvent } from "vsls";
import { ServiceChannelStreamCreationOptions } from "../api/models/stream";
import {
	SessionStatus,
	SessionStatusChangedEvent,
	StreamThread,
	StreamType,
	User
} from "../api/session";
import { ContextKeys, setContext } from "../common";
import { Container } from "../container";
import { Logger } from "../logger";
import { Dates } from "../system";

export interface VslsInviteServiceRequestAction {
	type: "invite";
	userId: string;
	createNewStream?: Boolean;
}

export interface VslsJoinServiceRequestAction {
	type: "join";
	url: string;
}

export interface VslsStartServiceRequestAction {
	type: "start";
	streamId: string;
	threadId?: string;
	createNewStream?: Boolean;
}

export type VslsServiceRequestAction =
	| VslsInviteServiceRequestAction
	| VslsJoinServiceRequestAction
	| VslsStartServiceRequestAction;

interface InviteCommandArgs {
	userIds: string | string[];
	createNewStream?: Boolean;
}

interface JoinCommandArgs {
	url: string;
}

interface StartCommandArgs {
	streamThread?: StreamThread;
	createNewStream?: Boolean;
}

export const vslsUrlRegex = /https:\/\/(?:.*?\.)?liveshare\.vsengsaas\.visualstudio\.com\/join\?(.+?)\b/;

export class LiveShareController implements Disposable {
	private _apiPromise: Promise<LiveShare | null> | undefined;
	private _disposable: Disposable | undefined;
	private _vslsId: string | undefined;

	constructor() {
		void this.initialize();
	}

	dispose() {
		this._disposable && this._disposable.dispose();
	}

	async initialize(): Promise<void> {
		try {
			// this._installed = this._vslsExtension != null;
			this._apiPromise = getApi();

			const api = await this._apiPromise;
			this._installed = api != null;
			if (api == null) return;

			setContext(ContextKeys.LiveShareInstalled, true);
			this.setVslsId(api.session.id);

			this._disposable = Disposable.from(
				Container.session.onDidChangeSessionStatus(this.onSessionStatusChanged, this),
				api.onDidChangeSession(this.onLiveShareSessionChanged, this)
			);
		} catch (ex) {
			debugger;
			Logger.error(ex);
		}
	}

	async ensureApi() {
		const api = await this._apiPromise;
		if (api == null) throw new Error("Live Share is not installed");

		return api;
	}

	private _installed: boolean = false;
	get installed() {
		return this._installed;
	}

	get vslsId(): string | undefined {
		return this._vslsId;
	}
	private setVslsId(id: string | null) {
		this._vslsId = id == null ? undefined : id;
		setContext(ContextKeys.LiveShareSessionActive, id != null);
	}

	private async onLiveShareSessionChanged(e: SessionChangeEvent) {
		const vslsId = e.session.id;
		this.setVslsId(vslsId);
		// If we aren't signed in or in an active (remote) live share session kick out
		if (Container.session.status !== SessionStatus.SignedIn || vslsId == null) return;

		// If we are in an active (remote) live share session, open the liveshare channel
		const vslsChannel = await this.getVslsChannel(vslsId);
		if (vslsChannel === undefined) return;

		Container.commands.openStream({
			streamThread: { id: undefined, streamId: vslsChannel.id }
		});
	}

	private async onSessionStatusChanged(e: SessionStatusChangedEvent) {
		const status = e.getStatus();
		// If we aren't signed in or in an active (remote) live share session kick out
		if (status !== SessionStatus.SignedIn || this.vslsId == null) return;

		// If we are in an active (remote) live share session, open the liveshare channel
		const vslsChannel = await this.getVslsChannel(this.vslsId);
		if (vslsChannel === undefined) return;

		Container.commands.openStream({
			streamThread: { id: undefined, streamId: vslsChannel.id }
		});
	}

	async invite(args: InviteCommandArgs) {
		const vsls = await this.ensureApi();

		const users = [];
		if (typeof args.userIds === "string") {
			const user = (await Container.agent.users.get(args.userIds)).user;
			if (user !== undefined) {
				users.push(new User(Container.session, user));
			}
		} else {
			for (const id of args.userIds) {
				const user = (await Container.agent.users.get(id)).user;
				if (user !== undefined) {
					users.push(new User(Container.session, user));
				}
			}
		}

		const currentUserId = Container.session.userId;
		const memberIds = [currentUserId, ...users.map(u => u.id)];

		const direct = await Container.session.getOrCreateDMByMembers(memberIds);

		Logger.log(
			"LiveShareController.invite:",
			`Users=${JSON.stringify(users.map(u => ({ id: u.id, name: u.name })))}`
		);

		const uri = await vsls.share({ suppressNotification: true });
		if (uri == null) {
			Logger.warn(
				"LiveShareController.invite: FAILED",
				`Users=${JSON.stringify(users.map(u => ({ id: u.id, name: u.name })))}`
			);

			return;
		}

		this.setVslsId(vsls.session.id);

		let vslsChannel;
		if (args.createNewStream) {
			// Create a new channel specifically for this live share session
			const name = this.getVslsChannelName();
			vslsChannel = await Container.session.getOrCreateChannelByService(
				ChannelServiceType.Vsls,
				vsls.session.id!,
				{
					name: name,
					membership: memberIds,
					privacy: "private"
				}
			);
		} else {
			vslsChannel = direct;
		}

		await direct.post(`Join my Live Share session: ${uri.toString()}`);
		return Container.commands.openStream({
			streamThread: { id: undefined, streamId: vslsChannel.id }
		});
	}

	async join(args: JoinCommandArgs) {
		const vsls = await this.ensureApi();

		const match = vslsUrlRegex.exec(args.url);
		if (match != null) {
			// Ensure we are a member of the channel
			await this.getVslsChannel(match[1]);
		}

		await vsls.join(Uri.parse(args.url), { newWindow: false });
	}

	async processRequest(action: VslsServiceRequestAction) {
		switch (action.type) {
			case "invite":
				await this.invite({ userIds: [action.userId], createNewStream: action.createNewStream });
				break;
			case "join":
				await this.join({ url: action.url });
				break;
			case "start":
				const stream = await Container.session.getStream(action.streamId);
				const streamThread =
					stream !== undefined ? { id: action.threadId, streamId: stream.id } : undefined;

				await this.start({
					streamThread: streamThread,
					createNewStream: action.createNewStream
				});
				break;
		}
	}

	async start(args: StartCommandArgs) {
		const vsls = await this.ensureApi();

		const streamThread = args.streamThread || Container.webview.activeStreamThread;
		if (streamThread === undefined) return;

		Logger.log("LiveShareController.start");

		const uri = await vsls.share({ suppressNotification: true });
		if (uri == null) {
			Logger.warn("LiveShareController.start: FAILED");

			return;
		}

		this.setVslsId(vsls.session.id);

		if (streamThread.streamId === undefined) return;

		const currentChannel = await Container.session.getStream(streamThread.streamId);
		if (currentChannel === undefined) return;

		await currentChannel.post(`Join my Live Share session: ${uri.toString()}`, streamThread.id);

		if (!args.createNewStream) return;

		// Create a new channel specifically for this live share session, based on the current channel
		const name = this.getVslsChannelName();
		let createOptions: ServiceChannelStreamCreationOptions;
		switch (currentChannel.type) {
			case StreamType.Direct:
				createOptions = {
					name: name,
					membership: currentChannel.memberIds,
					privacy: "private"
				};
				break;
			default:
				createOptions = {
					name: name,
					privacy: "public"
				};
				break;
		}

		const vslsChannel = await Container.session.getOrCreateChannelByService(
			ChannelServiceType.Vsls,
			vsls.session.id!,
			createOptions
		);

		return Container.commands.openStream({
			streamThread: { id: undefined, streamId: vslsChannel.id }
		});
	}

	private async getVslsChannel(vslsId: string) {
		const vslsChannel = await Container.session.getChannelByService(
			ChannelServiceType.Vsls,
			vslsId
		);

		// Ensure we are a member of the channel
		if (vslsChannel !== undefined && !vslsChannel.memberOf(Container.session.userId)) {
			await Container.agent.streams.join(vslsChannel.id);
		}

		return vslsChannel;
	}

	private getVslsChannelName() {
		return `${Container.session.user.name} - Live Share - ${Dates.toFormatter(new Date()).format(
			"MMM Do h-mm-ssa"
		)}`;
	}
}
