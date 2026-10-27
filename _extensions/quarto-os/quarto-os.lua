--[[
  Quarto OS: filter + `os` shortcode.

  Turns
    ::: {.os-window ...} / ::: {.os-desktop ...}  -> <div class="qos-window|qos-desktop" data-qos-opts='{…}'>
    {{< os APP key=val >}}                          -> <div class="qos-window" data-qos-opts='{…}'>
    [label]{.os-launch ...}                        -> <button class="qos-launch" data-qos-opts='{…}'>
    `cmd`{.os-run target=id} / ```{.os-run}       -> class "qos-run" + data-qos-target
  and adds the JSON config (`quarto-os:` YAML, camelCase keys + usesVM), the
  html dependency. v86 does not require cross-origin isolation.
  Only active for HTML formats that run JavaScript (html, revealjs, …).
]]

local VERSION = "0.2.1"
local VM_APPS = { terminal = true, vscode = true, explorer = true }
local DEFAULT_DOCK = "terminal,vscode,explorer"

-- shortcode and filter are loaded in separate environments of the same Lua state
-- (shared through package.loaded, `_G` is not visible to shortcode files)
local S = package.loaded["quarto-os-state"]
if type(S) ~= "table" then
  S = { vm = false, dep = false }
  package.loaded["quarto-os-state"] = S
end

local function is_html()
  return quarto.doc.is_format("html:js")
end

local SLIDE_FORMATS = { revealjs = true, slidy = true, s5 = true, dzslides = true, slideous = true }

-- Pandoc's section handling turns a div that *starts* with a heading into a
-- <section>, and in slide formats every heading at slide level (even nested in
-- a div) becomes a slide. So window/desktop content starts with a no-op raw
-- block, and in slide formats headings inside windows are emitted as raw <hN>.
local function guard_content(blocks)
  blocks = pandoc.Blocks(blocks)
  if SLIDE_FORMATS[FORMAT] then
    blocks = blocks:walk({
      Header = function(hd)
        local attrs = ""
        if hd.identifier ~= "" then attrs = attrs .. ' id="' .. hd.identifier .. '"' end
        if #hd.classes > 0 then attrs = attrs .. ' class="' .. table.concat(hd.classes, " ") .. '"' end
        local tag = "h" .. hd.level
        return { pandoc.RawBlock("html", "<" .. tag .. attrs .. ">"), pandoc.Plain(hd.content), pandoc.RawBlock("html", "</" .. tag .. ">") }
      end,
    })
  end
  blocks:insert(1, pandoc.RawBlock("html", "<!-- -->"))
  return blocks
end

---------------------------------------------------------------- JSON

local function jstr(s)
  s = s:gsub('[%c"\\]', function(c)
    if c == '"' then return '\\"' elseif c == '\\' then return '\\\\'
    elseif c == '\n' then return '\\n' elseif c == '\r' then return '\\r'
    elseif c == '\t' then return '\\t' end
    return string.format('\\u%04x', c:byte())
  end)
  return '"' .. s .. '"'
end

local function json(v)
  local t = type(v)
  if t == "string" then return jstr(v)
  elseif t == "number" then return tostring(v)
  elseif t == "boolean" then return v and "true" or "false"
  elseif t == "table" then
    if v.__array or #v > 0 then
      local out = {}
      for _, x in ipairs(v) do out[#out + 1] = json(x) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do if k ~= "__array" then keys[#keys + 1] = tostring(k) end end
    table.sort(keys)
    local out = {}
    for _, k in ipairs(keys) do out[#out + 1] = jstr(k) .. ":" .. json(v[k]) end
    return "{" .. table.concat(out, ",") .. "}"
  end
  return "null"
end

local function html_attr(s)
  return (s:gsub("&", "&amp;"):gsub("'", "&#39;"):gsub("<", "&lt;"):gsub(">", "&gt;"))
end

---------------------------------------------------------------- helpers

local function attr_table(attributes)
  local o = {}
  for k, v in pairs(attributes) do o[k] = v end
  return o
end

local function other_classes(classes, drop, add)
  local out = { add }
  for _, c in ipairs(classes) do if c ~= drop then out[#out + 1] = c end end
  return out
end

local function dir_exists(p)
  local ok, res = pcall(pandoc.system.list_directory, p)
  return ok and res ~= nil
end

local function ensure_dep()
  if S.dep then return end
  S.dep = true
  local res = {}
  for _, d in ipairs({ "apps", "vm", "vendor" }) do
    if dir_exists(quarto.utils.resolve_path(d)) then res[#res + 1] = d end
  end
  quarto.doc.add_html_dependency({
    name = "quarto-os",
    version = VERSION,
    scripts = { "quarto-os.js" },
    stylesheets = { "quarto-os.css" },
    resources = (#res > 0) and res or nil,
  })
end

local function note_app(app)
  if VM_APPS[app] then S.vm = true end
end

local function note_dock(dock)
  for name in (dock or DEFAULT_DOCK):gmatch("[^,%s]+") do note_app(name) end
end

-- a qos-window/qos-desktop element (Div, or Span in inline context)
local function os_element(kind, opts, id, classes, content, inline)
  local attr = pandoc.Attr(id or "", classes, { ["data-qos-opts"] = json(opts) })
  if inline then return pandoc.Span(content or {}, attr) end
  return pandoc.Div(content or {}, attr)
end

---------------------------------------------------------------- metadata → config

-- reverse pandoc's smart punctuation
local function unsmart(s)
  return (s:gsub("—", "---"):gsub("–", "--"):gsub("…", "..."):gsub("[‘’]", "'"):gsub("[“”]", '"'))
end

local inl2txt
local function blocks2txt(blocks)
  local out = {}
  for _, b in ipairs(blocks) do
    if b.t == "CodeBlock" or b.t == "RawBlock" then out[#out + 1] = b.text
    elseif b.t == "Para" or b.t == "Plain" then out[#out + 1] = inl2txt(b.content)
    elseif b.t == "LineBlock" then
      local ls = {}
      for _, l in ipairs(b.content) do ls[#ls + 1] = inl2txt(l) end
      out[#out + 1] = table.concat(ls, "\n")
    else out[#out + 1] = pandoc.utils.stringify(b) end
  end
  return table.concat(out, "\n\n")
end

local WRAP = { Emph = "*", Strong = "**", Strikeout = "~~", Subscript = "~", Superscript = "^" }
inl2txt = function(ils)
  local out = {}
  for _, il in ipairs(ils) do
    local t, s = il.t, nil
    if t == "Str" then s = unsmart(il.text)
    elseif t == "Space" then s = " "
    elseif t == "SoftBreak" or t == "LineBreak" then s = "\n"
    elseif t == "Code" then s = "`" .. il.text .. "`"
    elseif t == "RawInline" then s = il.text
    elseif t == "Math" then
      local d = il.mathtype == "DisplayMath" and "$$" or "$"
      s = d .. il.text .. d
    elseif t == "Quoted" then
      local q = il.quotetype == "DoubleQuote" and '"' or "'"
      s = q .. inl2txt(il.content) .. q
    elseif WRAP[t] then s = WRAP[t] .. inl2txt(il.content) .. WRAP[t]
    elseif t == "Link" then
      local txt = inl2txt(il.content)
      s = (txt == il.target or "mailto:" .. txt == il.target) and txt or ("[" .. txt .. "](" .. il.target .. ")")
    elseif il.content then s = inl2txt(il.content)
    else s = pandoc.utils.stringify(il) end
    out[#out + 1] = s
  end
  return table.concat(out)
end

-- Pandoc parses YAML strings as markdown. For block scalars (`setup: |`) try to
-- recover the exact source text from the document front matter / _quarto.yml.
local function read_file(p)
  if not p then return nil end
  local f = io.open(p, "rb")
  if not f then return nil end
  local s = f:read("a")
  f:close()
  return s
end

local function yaml_block(text, path)
  if not text then return nil end
  local lines = {}
  for l in (text .. "\n"):gmatch("([^\n]*)\n") do lines[#lines + 1] = l:gsub("\r$", "") end
  local stack = {}
  for i, line in ipairs(lines) do
    local ind, key, rest = line:match("^(%s*)([%w_%-]+):%s*(.-)%s*$")
    if key then
      ind = #ind
      while #stack > 0 and stack[#stack].ind >= ind do table.remove(stack) end
      stack[#stack + 1] = { ind = ind, key = key }
      local match = #stack == #path
      for j = 1, #stack do if match and stack[j].key ~= path[j] then match = false end end
      if match and rest:match("^[|>]") then
        local out, base = {}, nil
        for j = i + 1, #lines do
          local l = lines[j]
          if l:match("^%s*$") then out[#out + 1] = ""
          else
            local li = #l:match("^(%s*)")
            if li <= ind then break end
            base = base or li
            out[#out + 1] = l:sub(base + 1)
          end
        end
        while #out > 0 and out[#out] == "" do out[#out] = nil end
        return table.concat(out, "\n") .. "\n"
      end
    end
  end
  return nil
end

local raw_sources
local function raw_lookup(path)
  if not raw_sources then
    raw_sources = {}
    local src = read_file(quarto.doc.input_file)
    if src then
      local fm = src:match("^%s*%-%-%-\r?\n(.-)\r?\n%-%-%-")
      if fm then raw_sources[#raw_sources + 1] = fm end
    end
    local pdir = quarto.project and quarto.project.directory
    if pdir then
      raw_sources[#raw_sources + 1] = read_file(pandoc.path.join({ pdir, "_quarto.yml" }))
      raw_sources[#raw_sources + 1] = read_file(pandoc.path.join({ pdir, "_quarto.yaml" }))
    end
  end
  for _, s in ipairs(raw_sources) do
    local r = yaml_block(s, path)
    if r then return r end
  end
  return nil
end

local function camel(k)
  return (k:gsub("[-_](%w)", function(c) return c:upper() end))
end

local function scalar(s)
  if s:match("^%-?%d+%.?%d*$") then return tonumber(s) end
  return s
end

local function meta2lua(m, path)
  local t = pandoc.utils.type(m)
  if t == "boolean" or t == "number" then return m
  elseif t == "string" then return scalar(m)
  elseif t == "Inlines" then return scalar(inl2txt(m))
  elseif t == "Blocks" then return raw_lookup(path) or blocks2txt(m)
  elseif t == "List" then
    local out = { __array = true }
    for i, x in ipairs(m) do out[i] = meta2lua(x, path) end
    return out
  elseif t == "table" or t == "Meta" then
    local out = {}
    for k, v in pairs(m) do
      local p = { table.unpack(path) }
      p[#p + 1] = k
      out[camel(k)] = meta2lua(v, p)
    end
    return out
  end
  return pandoc.utils.stringify(m)
end

---------------------------------------------------------------- shortcode

local function os_shortcode(args, kwargs, meta, raw_args, context)
  if not is_html() then return {} end
  local app = args[1] and pandoc.utils.stringify(args[1]) or "content"
  if app == "" then app = "content" end
  local opts = { app = app }
  local id = ""
  for k, v in pairs(kwargs) do
    v = pandoc.utils.stringify(v)
    if k == "id" then id = v else opts[k] = v end
  end
  note_app(app)
  ensure_dep()
  -- The core also detects shortcode VM apps after the document filters run.
  local classes = { "qos-window" }
  if opts.class then
    for c in opts.class:gmatch("%S+") do classes[#classes + 1] = c end
    opts.class = nil
  end
  return os_element("window", opts, id, classes, {}, context == "inline" or context == "text")
end

---------------------------------------------------------------- filter

local function Div(el)
  local cls = el.classes
  if cls:includes("os-window") then
    if not is_html() then
      local app = el.attributes.app or "content"
      if app == "content" then return el.content end
      return {}
    end
    local opts = attr_table(el.attributes)
    opts.app = opts.app or "content"
    note_app(opts.app)
    ensure_dep()
    -- content goes into an inner .qos-body div (also stops pandoc from turning
    -- a div that starts with a heading into a <section>)
    local content = {}
    if opts.app == "content" then content = { pandoc.Div(guard_content(el.content), pandoc.Attr("", { "qos-body" })) } end
    return os_element("window", opts, el.identifier, other_classes(cls, "os-window", "qos-window"), content)
  elseif cls:includes("os-desktop") then
    if not is_html() then return el.content end
    local opts = attr_table(el.attributes)
    note_dock(opts.dock)
    ensure_dep()
    return os_element("desktop", opts, el.identifier, other_classes(cls, "os-desktop", "qos-desktop"), guard_content(el.content))
  end
  -- windows produced by the shortcode
  if cls:includes("qos-window") and el.attributes["data-qos-opts"] then
    local app = el.attributes["data-qos-opts"]:match('"app":"([^"]*)"')
    if app then note_app(app) end
  end
end

local function Span(el)
  if not el.classes:includes("os-launch") then return nil end
  if not is_html() then return el.content end
  local opts = attr_table(el.attributes)
  opts.app = opts.app or "terminal"
  note_app(opts.app)
  ensure_dep()
  local classes = table.concat(other_classes(el.classes, "os-launch", "qos-launch"), " ")
  local idattr = el.identifier ~= "" and (' id="' .. html_attr(el.identifier) .. '"') or ""
  local out = pandoc.Inlines({ pandoc.RawInline("html",
    '<button type="button" class="' .. html_attr(classes) .. '"' .. idattr ..
    " data-qos-opts='" .. html_attr(json(opts)) .. "'>") })
  out:extend(el.content)
  out:insert(pandoc.RawInline("html", "</button>"))
  return out
end

local function run_el(el)
  if not el.classes:includes("os-run") then return nil end
  local target = el.attributes.target
  el.attributes.target = nil
  if not is_html() then
    el.classes = other_classes(el.classes, "os-run", nil)
    return el
  end
  S.vm = true
  ensure_dep()
  -- keep the language class first so highlighting still works
  local classes = other_classes(el.classes, "os-run", nil)
  classes[#classes + 1] = "qos-run"
  el.classes = classes
  if target and target ~= "" then el.attributes["data-qos-target"] = target end
  return el
end

local function Pandoc(doc)
  if not is_html() then return nil end
  ensure_dep()
  local cfg = {}
  local m = doc.meta["quarto-os"]
  if m and pandoc.utils.type(m) == "table" then cfg = meta2lua(m, { "quarto-os" }) end
  if type(cfg) ~= "table" then cfg = {} end
  local vm = cfg.vm
  if type(vm) == "table" and vm.autoboot == true then S.vm = true end
  cfg.usesVM = S.vm
  cfg.version = VERSION
  -- Project-relative VM assets remain valid in nested pages and Pages subpaths.
  local off = quarto.project and quarto.project.offset
  if type(vm) == "table" and type(vm.assetBase) == "string" and
      not vm.assetBase:match("^%a[%w+.-]*:") and not vm.assetBase:match("^/") then
    vm.assetBase = (off and off ~= "") and (off .. "/" .. vm.assetBase) or vm.assetBase
  end
  local js = json(cfg):gsub("</", "<\\/")
  quarto.doc.include_text("in-header",
    '<script type="application/json" id="quarto-os-config">' .. js .. "</script>")

  return nil
end

-- One table serves as both the filter (Div/Span/Code/CodeBlock/Pandoc) and the
-- shortcode file (`os`); the extra keys are ignored by the other loader.
return {
  Div = Div,
  Span = Span,
  Code = run_el,
  CodeBlock = run_el,
  Pandoc = Pandoc,
  os = os_shortcode,
}
