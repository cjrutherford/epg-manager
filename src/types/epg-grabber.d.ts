declare module 'epg-grabber' {
    export class EPGGrabber {
        constructor(options?: any);
        grab(channel: any, date: any, options?: any): Promise<any>;
    }
    export class Channel {
        constructor(data?: any);
        id: string;
        name: string;
        site: string;
        site_id: string;
        lang?: string;
        logo?: string;
    }
}
