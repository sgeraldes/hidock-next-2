import fs from 'node:fs'
import path from 'node:path'
const source = 'G:/Code/Claude2Kiro/main.go'
const directory = path.resolve('node_modules/.cache/completion630-runtime/claude-proxy-diagnostic')
fs.mkdirSync(directory, { recursive: true })
const original = fs.readFileSync(source, 'utf8').replaceAll('\r\n', '\n')
const needle = '// Use CodeWhisperer parser\n\tevents := parser.ParseEvents(respBody)'
if (original.split(needle).length !== 2) throw Error('Diagnostic insertion is ambiguous')
const diagnostic = String.raw`
	if len(events) == 0 {
		meta := map[string]any{"bytes":len(respBody), "contentType":resp.Header.Get("Content-Type"), "contentEncoding":resp.Header.Get("Content-Encoding"), "gzip":len(respBody)>1 && respBody[0]==31 && respBody[1]==139}
		frameKeys := []string{}
		keyCounts := map[string]int{}
		eventCounts := map[string]int{}
		frameCount := 0
		validFrames := true
		for offset:=0; offset<len(respBody); {
			if offset+12>len(respBody) {validFrames=false;break}
			u32:=func(i int) int {return int(uint32(respBody[i])<<24|uint32(respBody[i+1])<<16|uint32(respBody[i+2])<<8|uint32(respBody[i+3]))}
			total,headers:=u32(offset),u32(offset+4)
			if total<16 || headers<0 || headers>total-16 || total>len(respBody)-offset {validFrames=false;break}
			payload:=respBody[offset+12+headers:offset+total-4]
			var object map[string]json.RawMessage
			if json.Unmarshal(payload,&object)==nil {
				keys:=[]string{};for key:=range object {if len(key)<80 {keys=append(keys,key);keyCounts[key]++}};slices.Sort(keys)
				if frameCount<12 {frameKeys=append(frameKeys,strings.Join(keys,","))}
			}
			for cursor,end:=offset+12,offset+12+headers;cursor<end; {
				nameLength:=int(respBody[cursor]);cursor++
				if cursor+nameLength+3>end {break}
				name:=string(respBody[cursor:cursor+nameLength]);cursor+=nameLength
				kind:=respBody[cursor];cursor++;if kind!=7 {break}
				length:=int(respBody[cursor])<<8|int(respBody[cursor+1]);cursor+=2
				if cursor+length>end {break}
				if name==":event-type" && length<80 {value:=string(respBody[cursor:cursor+length]);if regexp.MustCompile("^[A-Za-z][A-Za-z0-9_]*$").MatchString(value) {eventCounts[value]++}}
				cursor+=length
			}
			frameCount++;offset+=total
		}
		meta["standardEventFramesValid"]=validFrames;meta["frameCount"]=frameCount;meta["firstFrameJSONKeys"]=frameKeys;meta["JSONKeyCounts"]=keyCounts;meta["eventTypeCounts"]=eventCounts
		if bytes.HasPrefix(bytes.TrimSpace(respBody),[]byte("data:")) || bytes.HasPrefix(bytes.TrimSpace(respBody),[]byte("event:")) {meta["textSSE"]=true}
		encoded,_:=json.Marshal(meta);fmt.Fprintln(os.Stderr,"HIDOCK_REVIEW_TRANSPORT_METADATA "+string(encoded))
	}
`.replaceAll('\t', '	')
const target = path.join(directory, 'main.metadata.go')
fs.writeFileSync(target, original.replace(needle, needle + diagnostic))
fs.writeFileSync(path.join(directory, 'overlay.json'), JSON.stringify({ Replace: { [path.resolve(source)]: target } }, null, 2))
console.log(JSON.stringify({ overlay: path.join(directory, 'overlay.json'), executable: path.join(directory, 'claude2kiro-diagnostic.exe'), globalSourceChanged: false, contentLogged: false }))
