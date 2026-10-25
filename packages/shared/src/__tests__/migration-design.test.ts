import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, collectBlockAssets, defaultSiteSettings, renderBlocks, resolveBreakpointWidths, siteStylesCss, treePartStyleIssues, type Block, type SiteStyle } from '../index.js';
const registry = buildCoreBlockRegistry();
const render = (blocks: Block[], context = {}) => renderBlocks(blocks, {registry,renderVersion:9,context});

describe('migration design contracts', () => {
  it('marks only same-origin navigation as current, including absolute page URLs', () => {
    const links = [{label:'Home',href:'/'},{label:'External',href:'https://other.example/'},{label:'Self',href:'https://site.example/'},{label:'Anchor',href:'#top'}];
    const html = render([{id:'nav',type:'core/navigation_links',data:{links}}],{site:{url:'https://site.example/'},page:{path:'/'}});
    expect(html).toContain('href="/" aria-current="page"');
    expect(html).toContain('href="https://site.example/" aria-current="page"');
    expect(html).not.toContain('href="https://other.example/" aria-current');
    expect(html).not.toContain('href="#top" aria-current');
  });
  it('renders an escaped text wordmark even with an organization image logo', () => {
    const html = render([{id:'logo',type:'template/site_logo',data:{mode:'text',text:'ACME <&>'}}],{site:{name:'Acme',logo:'/logo.svg'}});
    expect(html).toContain('ACME &lt;&amp;&gt;');
    expect(html).not.toContain('<img');
  });
  it('emits heading-role spacing at the base and responsive breakpoint', () => {
    const styles: SiteStyle[] = [{id:'heading-two',name:'Heading two',role:'h2',targets:['heading'],base:{space_before:'2rem',space_after:'1rem'},at:{desktop:{space_before:'3rem'}}}];
    const css = siteStylesCss(styles,{breakpoints:resolveBreakpointWidths(undefined),colors:defaultSiteSettings.colors});
    expect(css).toContain('h2:not(#\\#){margin-block-start:2rem;margin-block-end:1rem}');
    expect(css).toContain('@media (min-width:1280px){h2:not(#\\#){margin-block-start:3rem}}');
  });
  it('keeps provider connections out of the initial video markup with a facade', () => {
    const blocks: Block[] = [{id:'v',type:'core/video',data:{video_url:'https://youtu.be/dQw4w9WgXcQ',click_to_load:true,title:'An example',poster:'/poster.webp'}}];
    const html = render(blocks);
    expect(html).toContain('data-video-src="https://www.youtube-nocookie.com/');
    expect(html).toContain('aria-label="Load video: An example"');
    expect(html).toContain('<img src="/poster.webp"');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('<a href="https://youtu.be/dQw4w9WgXcQ"');
    expect(html).not.toContain('<noscript');
    expect(html).not.toContain('i.ytimg.com');
    expect(collectBlockAssets(blocks,registry,{renderVersion:9}).js).toContain("register('core/video'");
  });
  it('has native responsive controls for columns, hero, section and small images', () => {
    const get = (type: string) => registry.get(type)!;
    expect(get('core/columns').schema.find(f => f.name === 'content_gap_px')?.responsive).toBe(true);
    expect(get('core/section').schema.find(f => f.name === 'padding_y')?.responsive).toBe(true);
    for (const name of ['focal_x','focal_y','image_fit','aspect_ratio','text_vertical','text_align']) expect(get('core/hero').schema.find(f => f.name === name)?.responsive).toBe(true);
    expect(render([{id:'img',type:'core/image',data:{src:'/small.webp',never_upscale:true}}])).toContain('data-no-upscale="true"');
    expect(get('core/post_card').schema.some(f => f.name === 'image_alt')).toBe(true);
  });
  it('checks global current-link styling against an explicit parent background', () => {
    const styles: SiteStyle[] = [{id:'current',name:'Current',targets:['link'],parts:['core/navigation_links.current_link'],base:{color:'#111111'}}];
    const tree: Block[] = [{id:'section',type:'core/section',data:{background:'#111111'},children:[{id:'nav',type:'core/navigation_links',data:{links:[{label:'Home',href:'/'}]}}]}];
    const issues = treePartStyleIssues(tree,registry,styles,{contrast:{colors:defaultSiteSettings.colors,renderVersion:9}});
    expect(issues.some(issue => issue.code === 'part_style_contrast')).toBe(true);
  });
});
