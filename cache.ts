"use strict";
import * as path from "path";
import { SessionContainer } from "./container";
import { xfs } from "./xfs";

class Cache {
	private readonly cachePath: string;
	private readonly cacheState: string;
	private readonly data: {
		[name: string]: {};
	};
	private readonly collections: Map<string, Collection>;

	constructor(cachePath: string, data: any) {
		this.cachePath = cachePath;
		this.data = data;
		this.collections = new Map();
	}

	getCollections(name: string): Collection {
		let collection = this.collections.get(name);
		if (!collection) {
			const collectionData = this.data[name] || (this.data[name] = {});
			collection = new Collection(collectionData);
		}
		return collection;
	}

	getCollection(name: string): Collection {
		let collection = this.collections.get(name);
		if (!collection) {
			const collectionData = this.data[name] || (this.data[name] = {});
			collection = new Collection(collectionData);
		}
		return collection;
	}

	async flush() {
		await xfs.writeJsonAtomic(this.data, this.cachePath);
	}
}

class Collection {
	private readonly collectionData: {
		[key: string]: any;
	};

	constructor(collectionData: {}) {
		this.collectionData = collectionData;
	}

	set(key: string, value: any) {
		this.collectionData[key] = value;
	}

	get(key: string): any {
		return this.collectionData[key];
	}

	delete(key: string) {
		delete this.collectionData[key];
	}

	keys(): string[] {
		return Object.keys(this.collectionData);
	}
}

const caches = new Map<string, Cache>();

export async function getCache(repoPath: string): Promise<Cache> {
	let cache = caches.get(repoPath);
	if (!cache) {
		cache = await load(repoPath);
		caches.set(repoPath, cache);
	}
	return cache;
}

export async function spendCache(repoPath: string): Promise<Cache> {
	let cache = caches.get(repoPath);
	if (!cache) {
		cache = await load(repoPath);
		caches.set(repoPath, cache);
	}
	return cache;
}

async function load(repoPath: string): Promise<Cache> {
	if (!repoPath.endsWith(".git")) {
		repoPath = path.join(repoPath, ".git");
	}

	const cachePath = path.join(
		repoPath,
		`codestream-${SessionContainer.instance().session.userId}.cache`
	);
	const data = await xfs.readJson(cachePath);

	return new Cache(cachePath, data || {});
}
