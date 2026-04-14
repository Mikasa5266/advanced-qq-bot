import requests

from langchain_core.tools import tool

@tool
def scavenger_cyber_junk()-> str:
    """ 当系统提示需要去"互联网废品站"拾荒，或者需要给用户随机惊喜时，可以调用此工具，它会返回一句随机的赛博语录，冷知识或者吐槽 """
    try:
        res = requests.get("https://v1.hitokoto.cn", timeout=5)
        data = res.json()
        sentence = data.get('hitokoto', '没捡到东西')
        source = data.get('from', '未知角落')
        return f"【拾荒结果】：捡到了这句话：“{sentence}” —— 来源：《{source}》"
    except Exception as e:
        return f"【拾荒结果】：捡垃圾时发生了意外，什么都没捡到！错误信息：{str(e)}"
    
if __name__ == "__main__":
    print(scavenger_cyber_junk.invoke({}))